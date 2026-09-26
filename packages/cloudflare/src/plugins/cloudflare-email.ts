/**
 * Cloudflare Email Provider Plugin
 *
 * Delivers EmDash emails (magic links, invites, comment notifications)
 * through Cloudflare Email Sending via a `send_email` Worker binding.
 * Registers `email:deliver` as an exclusive hook — activate the plugin,
 * then select it as the provider under Settings → Email.
 *
 * Without a production provider, deployments on Cloudflare only have the
 * dev console stub, and email-dependent auth flows (magic link login,
 * invites) fail with "Email is not configured".
 *
 * Every message is checked here, the last step before the binding, whatever
 * sent it:
 *
 * - `to`, `cc` and `replyTo` must each be one plain address. A `to` or `cc`
 *   that is not is refused; a `replyTo` that is not is dropped, and the
 *   message goes without it. A visitor's form input reaches `replyTo`, so it
 *   never reaches a header unchecked.
 * - The subject and the sender's name lose every control character (CR and
 *   LF among them) and are cut to a header's length.
 * - Each sending source ("system" for auth mail, "admin" for the test email,
 *   a plugin by its id) has its own budget of recipients per hour and per
 *   day, counted in the site's database, so one flooded form cannot spend the
 *   budget the owner's login email needs. A message over it is refused.
 *
 * The sender's name is `from.name` when the config gives one, otherwise the
 * site's title.
 *
 * @example
 * ```typescript
 * // astro.config.mjs
 * import emdash from "emdash/astro";
 * import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [
 *         cloudflareEmail({
 *           from: { email: "cms@mails.example.com", name: "My Site CMS" },
 *           replyTo: "hello@example.com",
 *         }),
 *       ],
 *     }),
 *   ],
 * });
 * ```
 *
 * @example
 * ```jsonc
 * // wrangler.jsonc — the sender domain must be onboarded for
 * // Email Sending (Cloudflare dashboard → Email Service). Restricting the
 * // binding to the sender makes it unable to send as anyone else.
 * {
 *   "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["cms@mails.example.com"] }]
 * }
 * ```
 */

import type { PluginContext, PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";
import type { EmailDeliverEvent } from "emdash/plugin";

/**
 * Cloudflare Email Provider Configuration
 */
export interface CloudflareEmailConfig {
	/**
	 * Name of the `send_email` binding in the wrangler config.
	 * @default "EMAIL"
	 */
	binding?: string;

	/**
	 * Sender address. Must belong to a domain onboarded for Cloudflare
	 * Email Sending. Either a bare address or `{ email, name }`. Without a
	 * name, the sender's name is the site's title.
	 */
	from: string | { email: string; name?: string };

	/**
	 * Optional Reply-To address — useful when the sender is a
	 * no-reply style subdomain address. A message's own `replyTo` takes
	 * precedence, then the site's own address (the plugin's "Reply-To"
	 * setting), then this.
	 */
	replyTo?: string;

	/**
	 * Recipients one sending source may reach, per hour and per day.
	 * @default { perHour: 50, perDay: 200 }
	 */
	limits?: { perHour?: number; perDay?: number };
}

/** Minimal shape of the Email Sending binding (`send_email` in wrangler). */
interface SendEmailBinding {
	send(message: {
		to: string | string[];
		cc?: string[];
		from: { email: string; name?: string };
		subject: string;
		text?: string;
		html?: string;
		replyTo?: string;
	}): Promise<{ messageId?: string }>;
}

/** A subject longer than this is cut: Email Sending refuses a header value over 2,048 bytes. */
const MAX_SUBJECT = 250;
/** A display name longer than this is cut (RFC 5322's recommended line length). */
const MAX_NAME = 78;

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators: none belongs in a header. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const WHITESPACE_RUN = /\s+/g;
/** A display name keeps no quote, angle bracket or backslash, so it cannot read as an address. */
const NAME_SPECIALS = /["<>\\]/g;
/**
 * `value` as one plain address, or null when it is anything else.
 *
 * One address is the WHATWG HTML "valid email address" (`<input type=email>`)
 * with at least one dot in the domain, and at most 254 characters, the longest
 * SMTP carries (RFC 5321, 4.5.3.1). Its local part has no whitespace, comma,
 * semicolon, angle bracket, quote or control character, so it cannot carry a
 * second address or a header break.
 *
 * The pattern is function-local, like `defineNativePlugin`'s: `createPlugin`
 * validates the sender with it while the generated plugins module
 * instantiates plugins, which can run during a circular module init, before a
 * module-scope const is initialized.
 */
export function mailbox(value: unknown): string | null {
	const pattern =
		// oxlint-disable-next-line e18e/prefer-static-regex -- avoids circular-init TDZ
		/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
	if (typeof value !== "string") return null;
	const v = value.trim();
	return v.length <= 254 && pattern.test(v) ? v : null;
}

/** The recipients one source may reach per hour and per day: the config's, over 50 and 200. */
export function limitsOf(config: CloudflareEmailConfig): { perHour: number; perDay: number } {
	return { perHour: 50, perDay: 200, ...config.limits };
}

/**
 * `value` as header text: controls become spaces, whitespace runs one space,
 * cut to `max` characters (whole graphemes, so an emoji is never split).
 */
export function headerText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const flat = value.replace(CONTROLS, " ").replace(WHITESPACE_RUN, " ").trim();
	return Array.from(new Intl.Segmenter().segment(flat), (g) => g.segment)
		.slice(0, max)
		.join("")
		.trim();
}

/** A sender's display name, or undefined when nothing printable is left. */
export function displayName(value: unknown): string | undefined {
	return (
		headerText(typeof value === "string" ? value.replace(NAME_SPECIALS, "") : "", MAX_NAME) ||
		undefined
	);
}

/**
 * Take `n` recipients from `source`'s budget for the hour and the day `now`
 * falls in, or say why not. Each count is one plugin KV key moved with
 * compare-and-set, so two sends at once cannot both take the last place. The
 * hour is taken first: a message the hour refuses spends nothing of the day.
 * Returns null when taken.
 */
export async function takeBudget(
	kv: PluginContext["kv"],
	source: string,
	n: number,
	limits: { perHour: number; perDay: number },
	now: Date,
): Promise<string | null> {
	const iso = now.toISOString();
	const windows = [
		{ key: `budget:h:${iso.slice(0, 13)}:${source}`, limit: limits.perHour, what: "hour" },
		{ key: `budget:d:${iso.slice(0, 10)}:${source}`, limit: limits.perDay, what: "day" },
	];
	for (const w of windows) {
		let taken = false;
		for (let attempt = 0; attempt < 5 && !taken; attempt++) {
			const current = await kv.getVersioned<number>(w.key);
			const count = typeof current?.value === "number" ? current.value : 0;
			if (count + n > w.limit) {
				return `"${source}" has sent to ${count} recipient(s) this ${w.what}, and ${n} more would pass its limit of ${w.limit}`;
			}
			if (!current) await dropOldBudgets(kv, iso);
			taken = (await kv.compareAndSet(w.key, current?.revision ?? null, count + n)).applied;
		}
		if (!taken)
			return `the ${w.what}'s budget for "${source}" kept changing under concurrent sends`;
	}
	return null;
}

/** Delete the counts of hours and days before `iso`'s: a new window's first send clears the old ones. Best effort. */
async function dropOldBudgets(kv: PluginContext["kv"], iso: string): Promise<void> {
	try {
		for (const { key } of await kv.list("budget:")) {
			const [, kind, window] = key.split(":");
			if (window !== (kind === "d" ? iso.slice(0, 10) : iso.slice(0, 13))) await kv.delete(key);
		}
	} catch {
		// A count left behind is a row, not a wrong answer: its window never comes back.
	}
}

/**
 * Resolve the Worker env at delivery time.
 *
 * Hooks run without request context, so the binding cannot come from
 * `Astro.locals.runtime`. The `cloudflare:workers` module exposes the
 * same env to any code bundled into the Worker — including in `astro dev`
 * when the Cloudflare Vite plugin provides the workerd runtime.
 *
 * The env is imported through `cloudflare-email-env.ts` rather than directly,
 * so the built-in module is referenced via a static import in a dedicated
 * helper. This avoids relying on a direct dynamic import of `cloudflare:workers`
 * in the bundled Worker, which some Astro Cloudflare builds do not resolve
 * correctly.
 */
async function loadWorkerEnv(): Promise<Record<string, unknown>> {
	try {
		const { env } = await import("./cloudflare-email-env.js");
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Env is deployment-specific; the binding lookup validates the shape
		return env as unknown as Record<string, unknown>;
	} catch {
		throw new Error(
			"[cloudflare-email] cloudflare:workers is not available — this provider " +
				"only runs on the Cloudflare Workers runtime (deployed or via astro dev " +
				"with the Cloudflare adapter).",
		);
	}
}

function bindingOf(env: Record<string, unknown>, name: string): SendEmailBinding | undefined {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding accessed from untyped env object; the send() check validates the shape
	const b = env[name] as SendEmailBinding | undefined;
	return b && typeof b.send === "function" ? b : undefined;
}

/** The site's own address: the plugin's Reply-To setting, when it holds one plain address. */
async function siteReplyTo(ctx: PluginContext): Promise<string | null> {
	return mailbox(await ctx.kv.get<string>("settings:replyTo"));
}

/**
 * Build the email:deliver handler.
 *
 * Exported for testing — production code should use {@link cloudflareEmail}.
 *
 * @internal
 */
export function createCloudflareEmailDeliver(
	config: CloudflareEmailConfig,
	loadEnv: () => Promise<Record<string, unknown>> = loadWorkerEnv,
	now: () => Date = () => new Date(),
): (event: EmailDeliverEvent, ctx: PluginContext) => Promise<void> {
	const bindingName = config.binding ?? "EMAIL";
	const from = typeof config.from === "string" ? { email: config.from } : config.from;
	const limits = limitsOf(config);

	return async (event, ctx) => {
		const { message, source } = event;
		const to = mailbox(message.to);
		const cc = (message.cc ?? []).map(mailbox);
		if (!to || cc.includes(null)) {
			throw new Error(
				"[cloudflare-email] refusing to send: every recipient must be one plain address",
			);
		}
		const subject = headerText(message.subject, MAX_SUBJECT);
		if (!subject) {
			throw new Error(
				"[cloudflare-email] refusing to send: the subject is empty once its control characters are removed",
			);
		}

		const env = await loadEnv();
		const binding = bindingOf(env, bindingName);
		if (!binding) {
			throw new Error(
				`[cloudflare-email] send_email binding "${bindingName}" not found — ` +
					`declare it in the wrangler config ("send_email": [{ "name": "${bindingName}" }]).`,
			);
		}

		if (message.replyTo !== undefined && !mailbox(message.replyTo)) {
			ctx.log.warn("reply-to dropped: it is not one plain address", { source });
		}
		const replyTo = mailbox(message.replyTo) ?? (await siteReplyTo(ctx)) ?? mailbox(config.replyTo);

		const refused = await takeBudget(ctx.kv, source, 1 + cc.length, limits, now());
		if (refused) {
			ctx.log.warn("email refused: sending budget spent", { source, why: refused });
			throw new Error(`[cloudflare-email] refusing to send: ${refused}`);
		}

		const name = displayName(from.name ?? ctx.site?.name);
		const result = await binding.send({
			from: name ? { email: from.email, name } : { email: from.email },
			to,
			subject,
			text: message.text,
			...(message.html ? { html: message.html } : {}),
			...(cc.length ? { cc: cc.filter((a) => a !== null) } : {}),
			...(replyTo ? { replyTo } : {}),
		});

		ctx.log.info("email delivered via Cloudflare Email Sending", {
			to,
			subject,
			source,
			messageId: result?.messageId,
		});
	};
}

/**
 * What the provider would send with, for the admin and for an operator's
 * import report: the sender, whether the Worker has the binding, where
 * replies go when a message names nobody. It sends nothing.
 *
 * @internal
 */
export function createCloudflareEmailStatus(
	config: CloudflareEmailConfig,
	loadEnv: () => Promise<Record<string, unknown>> = loadWorkerEnv,
) {
	const bindingName = config.binding ?? "EMAIL";
	const from = typeof config.from === "string" ? { email: config.from } : config.from;
	return async (ctx: PluginContext) => {
		const env = await loadEnv().catch((): Record<string, unknown> => ({}));
		const site = await siteReplyTo(ctx);
		return {
			provider: "cloudflare-email",
			from: from.email,
			senderName: from.name ? "configured" : "site title",
			binding: { name: bindingName, present: Boolean(bindingOf(env, bindingName)) },
			replyTo: site ? "site" : mailbox(config.replyTo) ? "configured" : null,
			limits: limitsOf(config),
		};
	};
}

/** Validate the sender address early so misconfiguration fails at config time. */
function assertValidFrom(config: CloudflareEmailConfig): void {
	const fromEmail = typeof config.from === "string" ? config.from : config.from?.email;
	if (!mailbox(fromEmail)) {
		throw new Error(
			'[cloudflare-email] config.from is required (e.g. { from: "cms@mails.example.com" }) — ' +
				"Cloudflare Email Sending rejects messages without a verified sender address.",
		);
	}
}

/**
 * Instantiate the Cloudflare Email Sending provider plugin.
 *
 * Called by the generated `virtual:emdash/plugins` module with the
 * `options` from the {@link cloudflareEmail} descriptor. Use
 * `cloudflareEmail()` in the astro config — this export exists so the
 * integration can bundle the plugin from a static entrypoint.
 */
export function createPlugin(config: CloudflareEmailConfig): ResolvedPlugin {
	assertValidFrom(config);
	const status = createCloudflareEmailStatus(config);
	return definePlugin({
		id: "cloudflare-email",
		version: "1.0.0",
		capabilities: ["hooks.email-transport:register"],
		hooks: {
			"email:deliver": {
				exclusive: true,
				handler: createCloudflareEmailDeliver(config),
			},
		},
		routes: {
			status: { handler: async (ctx) => status(ctx) },
		},
		admin: {
			settingsSchema: {
				replyTo: {
					type: "email",
					label: "Reply-To address",
					description:
						"Where replies go when a message names no reply-to of its own: the site's own address. A form with an email field replies to the visitor instead.",
				},
			},
		},
	});
}

/**
 * Create a Cloudflare Email Sending provider plugin descriptor.
 *
 * Pass it to the emdash() integration's plugins array, activate it under
 * Admin → Extensions, then select it under Settings → Email.
 *
 * Returns a `PluginDescriptor` (not an in-process definition): the astro
 * integration requires every `plugins: []` entry to resolve to a bundlable
 * `entrypoint`, so the descriptor points at this module and the integration
 * imports {@link createPlugin} from it at build time (#1721).
 */
export function cloudflareEmail(
	config: CloudflareEmailConfig,
): PluginDescriptor<CloudflareEmailConfig> {
	assertValidFrom(config);
	return {
		id: "cloudflare-email",
		version: "1.0.0",
		entrypoint: "@emdash-cms/cloudflare/plugins/cloudflare-email",
		format: "native",
		options: config,
		capabilities: ["hooks.email-transport:register"],
	};
}

export default cloudflareEmail;
