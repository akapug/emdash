/**
 * Public form submission handler.
 *
 * This is the main entry point for form submissions from anonymous visitors.
 * Handles spam protection, validation, file uploads, notifications, and webhooks.
 */

import type { RouteContext, StorageCollection } from "emdash";
import { after, PluginRouteError } from "emdash";
import { ulid } from "ulidx";

import { formatSubmissionText, formatWebhookPayload, sendFailure } from "../format.js";
import type { SubmitInput } from "../schemas.js";
import { verifyTurnstile } from "../turnstile.js";
import type { FormDefinition, Submission, SubmissionFile } from "../types.js";
import { getFormFields } from "../types.js";
import { evaluateCondition, validateSubmission } from "../validation.js";

/** Typed access to plugin storage collections */
function forms(ctx: RouteContext): StorageCollection<FormDefinition> {
	return ctx.storage.forms as StorageCollection<FormDefinition>;
}

function submissions(ctx: RouteContext): StorageCollection<Submission> {
	return ctx.storage.submissions as StorageCollection<Submission>;
}

/**
 * Whether two URLs name the same target, ignoring a difference that is not one.
 *
 * A configured `https://example.test/hook` answered by `https://example.test/hook/` is the same endpoint, and
 * warning about it would train editors to ignore the warning. Anything unparseable falls back to string equality.
 */
const withoutTrailingSlash = (u: URL) =>
	u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;

function sameTarget(a: string, b: string): boolean {
	try {
		const [x, y] = [new URL(a), new URL(b)];
		return (
			x.origin === y.origin &&
			withoutTrailingSlash(x) === withoutTrailingSlash(y) &&
			x.search === y.search
		);
	} catch {
		return a === b;
	}
}

/** How many submissions of one form may send mail, per hour and per day. */
export interface NotificationLimits {
	perHour: number;
	perDay: number;
}

export const DEFAULT_NOTIFICATION_LIMITS: NotificationLimits = { perHour: 10, perDay: 50 };

/**
 * Why this submission sends no mail, or null when it may.
 *
 * The submissions the form already stored are the count: this one is stored
 * before the check, so it is among them, and a flood stops being mailed at the
 * limit while every submission is still kept. Counted per form, so one form's
 * flood leaves the others' mail alone.
 */
async function mailRefusal(
	ctx: RouteContext<SubmitInput>,
	formId: string,
	limits: NotificationLimits,
	now: Date,
): Promise<string | null> {
	const windows = [
		{ what: "hour", ms: 3_600_000, limit: limits.perHour },
		{ what: "day", ms: 86_400_000, limit: limits.perDay },
	];
	for (const w of windows) {
		const since = new Date(now.getTime() - w.ms).toISOString();
		const n = await submissions(ctx).count({ formId, createdAt: { gte: since } });
		if (n > w.limit)
			return `the form has taken ${n} submissions in the last ${w.what}, past its limit of ${w.limit}`;
	}
	return null;
}

/** The visitor's own address: the first email field they filled in. Replies to a notification go to them. */
function visitorAddress(
	fields: ReturnType<typeof getFormFields>,
	data: Record<string, unknown>,
): string | null {
	for (const f of fields) {
		const v = f.type === "email" ? data[f.name] : undefined;
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return null;
}

export async function submitHandler(
	ctx: RouteContext<SubmitInput>,
	limits: NotificationLimits = DEFAULT_NOTIFICATION_LIMITS,
) {
	const input = ctx.input;

	// 1. Load form definition (by ID first, then by slug)
	let formId = input.formId;
	let form = await forms(ctx).get(formId);
	if (!form) {
		const bySlug = await forms(ctx).query({
			where: { slug: input.formId },
			limit: 1,
		});
		if (bySlug.items.length > 0) {
			formId = bySlug.items[0]!.id;
			form = bySlug.items[0]!.data;
		}
	}
	if (!form) {
		throw PluginRouteError.notFound("Form not found");
	}

	if (form.status === "paused") {
		throw new PluginRouteError(
			"FORM_PAUSED",
			"This form is not currently accepting submissions",
			410,
		);
	}

	const settings = form.settings;

	// 2. Spam protection
	if (settings.spamProtection === "turnstile") {
		const token = input.data["cf-turnstile-response"];
		if (typeof token !== "string" || !token) {
			throw PluginRouteError.forbidden("Spam verification required");
		}

		const secretKey = await ctx.kv.get<string>("settings:turnstileSecretKey");
		if (!secretKey || !ctx.http) {
			throw PluginRouteError.internal("Turnstile is not configured");
		}

		const result = await verifyTurnstile(
			token,
			secretKey,
			ctx.http.fetch.bind(ctx.http),
			ctx.requestMeta.ip,
		);

		if (!result.success) {
			ctx.log.warn("Turnstile verification failed", {
				errorCodes: result.errorCodes,
			});
			throw PluginRouteError.forbidden("Spam verification failed. Please try again.");
		}
	}

	if (settings.spamProtection === "honeypot") {
		if (input.data._hp) {
			// Honeypot triggered — return success silently
			return {
				success: true,
				message: settings.confirmationMessage,
			};
		}
	}

	// 3. Validate submission data
	const allFields = getFormFields(form);
	const result = validateSubmission(allFields, input.data, new Set(Object.keys(input.files ?? {})));

	if (!result.valid) {
		return { success: false, errors: result.errors };
	}

	// 4. Upload files
	const files: SubmissionFile[] = [];
	const pending = allFields.flatMap((field) => {
		if (field.type !== "file") return [];
		if (field.condition && !evaluateCondition(field.condition, input.data)) return [];
		const fileData = input.files?.[field.name];
		return fileData ? [{ field, fileData }] : [];
	});
	if (pending.length > 0 && !(ctx.media && "upload" in ctx.media)) {
		throw PluginRouteError.internal("File uploads are not configured");
	}
	if (pending.length > 0) {
		const mediaWithWrite = ctx.media as {
			upload(
				filename: string,
				contentType: string,
				bytes: ArrayBuffer,
			): Promise<{ mediaId: string; storageKey: string; url: string }>;
			delete(id: string): Promise<boolean>;
		};

		for (const { field, fileData } of pending) {
			// Validate file type
			if (field.validation?.accept) {
				const allowed = field.validation.accept.split(",").map((s) => s.trim().toLowerCase());
				const ext = `.${fileData.filename.split(".").pop()?.toLowerCase()}`;
				const typeMatch = allowed.some(
					(a) =>
						a === ext ||
						a === fileData.contentType ||
						fileData.contentType.startsWith(a.replace("/*", "/")),
				);
				if (!typeMatch) {
					throw PluginRouteError.badRequest(`File type not allowed for ${field.label}`);
				}
			}

			// Validate file size
			if (
				field.validation?.maxFileSize &&
				fileData.bytes.byteLength > field.validation.maxFileSize
			) {
				throw PluginRouteError.badRequest(
					`File too large for ${field.label}. Maximum: ${Math.round(field.validation.maxFileSize / 1024)} KB`,
				);
			}
		}

		try {
			for (const { field, fileData } of pending) {
				const uploaded = await mediaWithWrite.upload(
					fileData.filename,
					fileData.contentType,
					fileData.bytes.buffer,
				);

				files.push({
					fieldName: field.name,
					filename: fileData.filename,
					contentType: fileData.contentType,
					size: fileData.bytes.byteLength,
					mediaId: uploaded.mediaId,
				});
			}
		} catch (error) {
			await Promise.allSettled(files.map((file) => mediaWithWrite.delete(file.mediaId)));
			throw error;
		}
	}

	// 5. Store submission
	const submissionId = ulid();
	const submission: Submission = {
		formId,
		data: result.data,
		files: files.length > 0 ? files : undefined,
		status: "new",
		starred: false,
		createdAt: new Date().toISOString(),
		meta: {
			ip: ctx.requestMeta.ip,
			userAgent: ctx.requestMeta.userAgent,
			referer: ctx.requestMeta.referer,
			country: ctx.requestMeta.geo?.country ?? null,
		},
	};

	await submissions(ctx).put(submissionId, submission);

	// 6. Update form counters (use count() to avoid race conditions
	// from concurrent submissions doing read-modify-write)
	const submissionCount = await submissions(ctx).count({ formId });
	await forms(ctx).put(formId, {
		...form,
		submissionCount,
		lastSubmissionAt: new Date().toISOString(),
	});

	// 7. Immediate email notifications (not digest), within the form's mail limits.
	//
	// Reply-To is the visitor when the form asked for their address, so the owner answers them
	// with one click; the email provider checks it is one plain address before it becomes a header.
	const notifies = settings.notifyEmails.length > 0 && !settings.digestEnabled;
	const mails = Boolean(ctx.email) && (notifies || Boolean(settings.autoresponder));
	const refused = mails ? await mailRefusal(ctx, formId, limits, new Date()) : null;
	if (refused) {
		ctx.log.warn("Submission stored; no email sent for it", { formId, why: refused });
	}
	if (!refused && notifies && ctx.email) {
		const text = formatSubmissionText(form, result.data, files);
		const replyTo = visitorAddress(allFields, result.data);
		for (const email of settings.notifyEmails) {
			await ctx.email
				.send({
					to: email,
					subject: `New submission: ${form.name}`,
					text,
					...(replyTo ? { replyTo } : {}),
				})
				.catch((err: unknown) => {
					ctx.log.error("Failed to send notification email", sendFailure(err, email));
				});
		}
	}

	// 8. Autoresponder
	if (!refused && settings.autoresponder && ctx.email) {
		const emailField = allFields.find((f) => f.type === "email");
		const submitterEmail = emailField ? result.data[emailField.name] : null;
		if (typeof submitterEmail === "string" && submitterEmail) {
			await ctx.email
				.send({
					to: submitterEmail,
					subject: settings.autoresponder.subject,
					text: settings.autoresponder.body,
				})
				.catch((err: unknown) => {
					ctx.log.error("Failed to send autoresponder", { error: String(err) });
				});
		}
	}

	// 9. Webhook, deferred past the response rather than dropped.
	//
	// `after()` hands the promise to the host's lifetime extender (`waitUntil` under workerd), so the
	// call is still guaranteed to run once the visitor has their confirmation. A bare floating promise
	// is not: the isolate may be torn down as soon as the response is sent.
	//
	// The response is inspected too, because `fetch` only rejects on a transport error. A 4xx or 5xx
	// resolves, and so does the login page a webhook behind an auth wall redirects to, which is why a
	// misconfigured webhook could fail on every submission and log nothing.
	//
	// Redirects are detected by comparing the final URL, NOT by `response.redirected`: plugin HTTP access
	// follows redirects itself with `redirect: "manual"` so it can strip credentials on a cross-origin hop,
	// so the response it hands back always reports `redirected: false` however many hops it took.
	if (settings.webhookUrl && ctx.http) {
		const payload = formatWebhookPayload(form, submissionId, result.data, files);
		const { http, log } = ctx;
		const url = settings.webhookUrl;
		after(async () => {
			try {
				const response = await http.fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				});
				if (!response.ok) {
					log.error("Webhook failed", { url, status: response.status });
				} else if (response.url && !sameTarget(response.url, url)) {
					// A 2xx from somewhere else. Usually an auth wall, and the webhook never ran.
					log.warn("Webhook was redirected", { url, finalUrl: response.url });
				}
			} catch (error: unknown) {
				log.error("Webhook failed", { url, error: String(error) });
			}
		});
	}

	// 10. Return success
	return {
		success: true,
		message: settings.confirmationMessage,
		redirect: settings.redirectUrl,
	};
}

// ─── Public Form Definition Endpoint ─────────────────────────────

export async function definitionHandler(
	ctx: RouteContext<import("../schemas.js").DefinitionInput>,
) {
	const { id } = ctx.input;

	// Look up by ID first, then by slug
	let form = await forms(ctx).get(id);

	if (!form) {
		const bySlug = await forms(ctx).query({
			where: { slug: id },
			limit: 1,
		});
		if (bySlug.items.length > 0) {
			form = bySlug.items[0]!.data;
		}
	}

	if (!form) {
		throw PluginRouteError.notFound("Form not found");
	}

	if (form.status !== "active") {
		throw new PluginRouteError("FORM_PAUSED", "This form is not currently available", 410);
	}

	// Include Turnstile site key if configured
	const turnstileSiteKey =
		form.settings.spamProtection === "turnstile"
			? await ctx.kv.get<string>("settings:turnstileSiteKey")
			: null;

	// Return only the settings needed for client rendering — never expose
	// admin emails, webhook URLs, or other internal configuration.
	return {
		name: form.name,
		slug: form.slug,
		pages: form.pages,
		settings: {
			spamProtection: form.settings.spamProtection,
			submitLabel: form.settings.submitLabel,
			nextLabel: form.settings.nextLabel,
			prevLabel: form.settings.prevLabel,
		},
		status: form.status,
		_turnstileSiteKey: turnstileSiteKey,
	};
}
