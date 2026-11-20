/**
 * POST /_emdash/api/auth/invite
 *
 * Create an invite for a new user. Admin only.
 *
 * When an email provider is configured (via the plugin email pipeline),
 * the invite email is sent automatically, and the answer says `emailed: true`
 * only when the pipeline reports it sent. Otherwise (no provider, or a send
 * that did not report "sent") it answers `emailed: false` with the invite URL
 * for the admin to share manually (copy-link fallback).
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { getInviteEmailStrings } from "@emdash-cms/admin/locales/emails";
import { createInvite, InviteError, Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { resolveEmailLocale } from "#api/email-locale.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { inviteCreateBody } from "#api/schemas.js";
import { getSiteBaseUrl } from "#api/site-url.js";
import {
	SYSTEM_MAIL_PROTOCOL,
	askMediator,
	credentialOf,
	systemMailOf,
} from "#auth/system-mail.js";
import { OptionsRepository } from "#db/repositories/options.js";
import type { EmailSendResult } from "#plugins/email.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!user || user.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const adapter = createKyselyAdapter(emdash.db);

	try {
		const body = await parseBody(request, inviteCreateBody);
		if (isParseError(body)) return body;

		// Default to AUTHOR role if not specified (Zod validates the level)
		const role = body.role ?? Role.AUTHOR;

		// Get site config for invite email
		const options = new OptionsRepository(emdash.db);
		const siteOptions = await options.getMany<string>(["emdash:site_title", "emdash:locale"]);
		const siteName = siteOptions.get("emdash:site_title") || "EmDash";

		// Use the configured site URL (stored option as fallback) to prevent Host header spoofing in invite emails
		const baseUrl = await getSiteBaseUrl(emdash.db, request, emdash.config);

		// Mediated (the config's systemMail): the auth-mail mediator
		// authenticates the admin itself from this request's own credential,
		// issues the invite and sends it. Nothing about that message is built or
		// sent here. When it is not sent (no binding, a refusal), the invite is
		// made here with no email and its link returned, as for a site with no
		// email provider: this Worker never mails it. When whether it was sent
		// is not known, the broker may have made and mailed one: none is made
		// here, and the answer never says it was not sent.
		const mail = await systemMailOf(emdash.config);
		if (mail.mediated) {
			const outcome =
				"mediator" in mail
					? await askMediator((requestId) =>
							mail.mediator.createInvite({
								protocol: SYSTEM_MAIL_PROTOCOL,
								requestId,
								email: body.email,
								role,
								...credentialOf(request),
							}),
						)
					: { status: "refused" as const, why: mail.missing };
			if (outcome.status === "sent") {
				return apiSuccess({
					success: true,
					emailed: true,
					message: `Invite sent to ${body.email}`,
				});
			}
			if (outcome.status === "unknown") {
				console.warn(`[invite] not known to be emailed: ${outcome.why}`);
				return apiError(
					"INVITE_EMAIL_UNKNOWN",
					"The invite may have been emailed: whether it was is not known, so no second invite was made. Ask the invitee to check their inbox before you invite them again.",
					502,
				);
			}
			console.warn(`[invite] not emailed: ${outcome.why}`);
			const unsent = await createInvite({ baseUrl, siteName }, adapter, body.email, role, user.id);
			return apiSuccess(
				{
					success: true,
					emailed: false,
					message: "Invite created. Its email was not sent — share the link manually.",
					inviteUrl: unsent.url,
				},
				200,
			);
		}

		// Build email sender from the plugin pipeline (if available), keeping
		// what the pipeline says the send came to.
		let outcome: EmailSendResult | undefined;
		const emailSend = emdash.email?.isAvailable()
			? async (message: { to: string; subject: string; text: string; html?: string }) => {
					outcome = await emdash.email!.send(message, "system");
				}
			: undefined;

		// Localize the invite email copy. Only resolved when an
		// email will actually be sent — the copy-link fallback has no copy.
		const emailLocale = emailSend
			? resolveEmailLocale(siteOptions.get("emdash:locale"), request)
			: undefined;
		const emailStrings = emailLocale
			? await getInviteEmailStrings(emailLocale, siteName)
			: undefined;

		const result = await createInvite(
			{
				baseUrl,
				siteName,
				email: emailSend,
				emailStrings,
				emailLocale,
			},
			adapter,
			body.email,
			role,
			user.id,
		);

		if (outcome?.status === "sent") {
			return apiSuccess({
				success: true,
				emailed: true,
				message: `Invite sent to ${body.email}`,
			});
		}

		// No email was sent — return the invite URL for manual sharing
		return apiSuccess(
			{
				success: true,
				emailed: false,
				message: emailSend
					? "Invite created. Its email was not sent — share the link manually."
					: "Invite created. No email provider configured — share the link manually.",
				inviteUrl: result.url,
			},
			200,
		);
	} catch (error) {
		if (error instanceof InviteError) {
			const statusMap: Record<string, number> = {
				user_exists: 409,
				invalid_token: 400,
				token_expired: 400,
			};
			return apiError(error.code.toUpperCase(), error.message, statusMap[error.code] ?? 400);
		}

		return handleError(error, "Failed to create invite", "INVITE_CREATE_ERROR");
	}
};
