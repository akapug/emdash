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
 * - A `cc` is refused unless the config allows it (`allowCc`): a binding
 *   restricted to some recipients (`allowed_destination_addresses`) is only
 *   known to check `to` against them.
 * - The subject and the sender's name lose every control character (CR and
 *   LF among them) and are cut to a header's length.
 * - Recipients are counted in the site's database, each count one row moved
 *   with compare-and-set: each sending source ("system" for auth mail,
 *   "admin" for the test email, a plugin by its id) has its own budget per
 *   hour and per day, so one flooded form cannot spend the budget the
 *   owner's login email needs; every source together has a daily total, so
 *   the site cannot spend more of a shared account's sending than that, and
 *   a part of it is kept for "system" mail, so forms and comments together
 *   cannot spend the day the owner's login email needs; and "system" mail
 *   (magic links, invites) reaches any one address only so often a day, so
 *   requests from rotating IPs can neither flood one inbox nor spend the
 *   day. A message over any of them is refused, and a message the binding
 *   refuses gives its places back: only a send Cloudflare accepts is counted.
 *   A send moves its own counts and deletes none: the counts of windows that
 *   are over go in a daily cron task ({@link pruneBudgets}), a bounded number
 *   at a time, and never the current window's or the one before it.
 * - A log names a recipient's domain, never the address, and an error the
 *   binding throws has the address replaced by its domain.
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
	 * How many recipients the site may reach: one sending source per hour
	 * (`perHour`) and per day (`perDay`), every source together per day
	 * (`perDayTotal`), of which every source but "system" may take all but
	 * `systemReserve`, and "system" mail to any one address per day
	 * (`systemPerRecipient`).
	 * @default { perHour: 50, perDay: 200, perDayTotal: 300, systemReserve: 50, systemPerRecipient: 10 }
	 */
	limits?: Partial<SendingLimits>;

	/**
	 * Send a message's `cc`. Off by default: a `send_email` binding restricted
	 * to some recipients is only known to check `to` against them.
	 * @default false
	 */
	allowCc?: boolean;
}

/** How many recipients the site may reach (see {@link CloudflareEmailConfig.limits}). */
export interface SendingLimits {
	perHour: number;
	perDay: number;
	perDayTotal: number;
	/** The part of `perDayTotal` only "system" mail (magic links, invites) may take. */
	systemReserve: number;
	systemPerRecipient: number;
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
/** ASCII capitals, folded to find an address in an error's text whatever its case. */
const ASCII_UPPER = /[A-Z]/g;
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

/** How many recipients the site may reach: the config's, over 50 an hour and 200 a day per source, 300 a day in all with 50 of them kept for "system" mail, and 10 a day of "system" mail to one address. */
export function limitsOf(config: CloudflareEmailConfig): SendingLimits {
	return {
		perHour: 50,
		perDay: 200,
		perDayTotal: 300,
		systemReserve: 50,
		systemPerRecipient: 10,
		...config.limits,
	};
}

/** The domain of one plain address, which a log names in place of the address. */
export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
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

/** One count the budget moved: the row, and by how much. */
export interface Taken {
	key: string;
	n: number;
}

/**
 * A key's own counter never passes `limit`: one compare-and-set per try, so two
 * sends at once cannot both take the last place. It moves this one row and
 * nothing else: a send deletes no count, of its own window or any other
 * ({@link pruneBudgets} does that, apart from sending).
 */
async function takeOne(
	kv: PluginContext["kv"],
	key: string,
	n: number,
	limit: number,
): Promise<"taken" | { count: number } | "contended"> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const current = await kv.getVersioned<number>(key);
		const count = typeof current?.value === "number" ? current.value : 0;
		if (count + n > limit) return { count };
		if ((await kv.compareAndSet(key, current?.revision ?? null, count + n)).applied) return "taken";
	}
	return "contended";
}

/**
 * The hash a recipient's own count is kept under: the site's database holds a
 * count per address without holding the address.
 */
async function recipientKey(address: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(address.toLowerCase()),
	);
	return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Take a message's places for the hour and the day `now` falls in, or say why
 * not: `recipients` from `source`'s hour and day, from every source's day
 * total (all of it for "system" mail, all but its reserve for any other
 * source), and, for "system" mail, one from each recipient's own day. Every
 * count is one row in plugin KV (the site's database) moved with
 * compare-and-set. A refusal gives back what it took before it, so a refused
 * message spends nothing; the caller gives the rest back
 * ({@link refundBudget}) when the binding refuses the message.
 */
export async function takeBudget(
	kv: PluginContext["kv"],
	source: string,
	recipients: readonly string[],
	limits: SendingLimits,
	now: Date,
): Promise<{ refused: string } | { taken: Taken[] }> {
	const iso = now.toISOString();
	const [day, hour] = [iso.slice(0, 10), iso.slice(0, 13)];
	const n = recipients.length;
	const windows: Array<{ key: string; n: number; limit: number; what: string }> = [];
	if (source === "system") {
		for (const address of new Set(recipients.map((a) => a.toLowerCase()))) {
			windows.push({
				key: `budget:r:${day}:${await recipientKey(address)}`,
				n: 1,
				limit: limits.systemPerRecipient,
				what: `"system" mail to an address at ${domainOf(address)} today`,
			});
		}
	}
	windows.push(
		{ key: `budget:h:${hour}:${source}`, n, limit: limits.perHour, what: `"${source}" this hour` },
		{ key: `budget:d:${day}:${source}`, n, limit: limits.perDay, what: `"${source}" this day` },
		source === "system" || limits.systemReserve <= 0
			? {
					key: `budget:t:${day}`,
					n,
					limit: limits.perDayTotal,
					what: "every source together this day",
				}
			: {
					key: `budget:t:${day}`,
					n,
					limit: Math.max(0, limits.perDayTotal - limits.systemReserve),
					what: `every source together this day, less the ${limits.systemReserve} kept for "system" mail,`,
				},
	);
	const taken: Taken[] = [];
	for (const w of windows) {
		const r = await takeOne(kv, w.key, w.n, w.limit);
		if (r === "taken") {
			taken.push({ key: w.key, n: w.n });
			continue;
		}
		await refundBudget(kv, taken);
		return {
			refused:
				r === "contended"
					? `the budget for ${w.what} kept changing under concurrent sends`
					: `${w.what} has reached ${r.count} recipient(s), and ${w.n} more would pass its limit of ${w.limit}`,
		};
	}
	return { taken };
}

/** Give back what {@link takeBudget} took, each row with compare-and-set. Best effort: a count left high refuses sooner, never later. */
export async function refundBudget(
	kv: PluginContext["kv"],
	taken: readonly Taken[],
): Promise<void> {
	for (const t of taken) {
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await kv.getVersioned<number>(t.key);
			if (!current || typeof current.value !== "number") break;
			if (
				(await kv.compareAndSet(t.key, current.revision, Math.max(0, current.value - t.n))).applied
			)
				break;
		}
	}
}

/** The cron task that runs {@link pruneBudgets}, once a day. */
export const PRUNE_TASK = "prune-budgets";
/** The most counts one prune deletes; the next day's run takes the rest. */
export const PRUNE_MAX = 500;

/**
 * Delete counts of windows that are over: an hour's (`budget:h:`) once it is
 * two hours or more before `now`'s, a day's (`budget:d:`, `budget:t:`,
 * `budget:r:`) once it is two days or more before it. The window just before
 * the current one stays too, so a send that started in it and is still
 * running finds its count, and no clock `now` can be read from makes this
 * delete the current window or a later one: a prune that stalled only reads
 * an earlier `now`, which deletes less. At most `max` counts go; a key it does
 * not recognize is kept. Runs apart from sending (the plugin's daily cron
 * task), never on the way to a send. Returns what it deleted, and whether
 * more is left.
 */
export async function pruneBudgets(
	kv: PluginContext["kv"],
	now: Date,
	max = PRUNE_MAX,
): Promise<{ deleted: number; more: boolean }> {
	const HOUR = 3_600_000;
	const hourCut = new Date(now.getTime() - HOUR).toISOString().slice(0, 13);
	const dayCut = new Date(now.getTime() - 24 * HOUR).toISOString().slice(0, 10);
	let deleted = 0;
	for (const { key } of await kv.list("budget:")) {
		// budget:<kind>:<window>[:<who>], the window an hour (13 characters) or a day (10).
		const [, kind, window = ""] = key.split(":");
		const over =
			kind === "h"
				? window.length === 13 && window < hourCut
				: (kind === "d" || kind === "t" || kind === "r") && window.length === 10 && window < dayCut;
		if (!over) continue;
		if (deleted >= max) return { deleted, more: true };
		await kv.delete(key);
		deleted++;
	}
	return { deleted, more: false };
}

/** Schedule the daily prune; the same task again is a no-op until it is due. */
async function schedulePrune(ctx: PluginContext): Promise<void> {
	await ctx.cron?.schedule(PRUNE_TASK, { schedule: "@daily" });
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
		const checked = (message.cc ?? []).map(mailbox);
		if (!to || checked.includes(null)) {
			throw new Error(
				"[cloudflare-email] refusing to send: every recipient must be one plain address",
			);
		}
		const cc = checked.filter((a): a is string => a !== null);
		if (cc.length && config.allowCc !== true) {
			throw new Error(
				"[cloudflare-email] refusing to send: a cc is not sent unless the config allows it (allowCc), because a send_email binding restricted to some recipients is only known to check `to` against them",
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

		const budget = await takeBudget(ctx.kv, source, [to, ...cc], limits, now());
		if ("refused" in budget) {
			ctx.log.warn("email refused: sending budget spent", { source, why: budget.refused });
			throw new Error(`[cloudflare-email] refusing to send: ${budget.refused}`);
		}

		const name = displayName(from.name ?? ctx.site?.name);
		let result: { messageId?: string } | undefined;
		try {
			result = await binding.send({
				from: name ? { email: from.email, name } : { email: from.email },
				to,
				subject,
				text: message.text,
				...(message.html ? { html: message.html } : {}),
				...(cc.length ? { cc } : {}),
				...(replyTo ? { replyTo } : {}),
			});
		} catch (error) {
			// Only a send Cloudflare accepts spends the budget.
			await refundBudget(ctx.kv, budget.taken);
			if (error instanceof Error) error.message = withoutAddresses(error.message, [to, ...cc]);
			throw error;
		}

		ctx.log.info("email delivered via Cloudflare Email Sending", {
			toDomain: domainOf(to),
			...(cc.length ? { cc: cc.length } : {}),
			subject,
			source,
			messageId: result?.messageId,
		});
	};
}

/** `text` with each of `addresses` (in any case) replaced by its domain: an error the binding throws may name its recipient, and it is logged. */
export function withoutAddresses(text: string, addresses: readonly string[]): string {
	// ASCII case only, so an index into the folded text is an index into the text.
	const fold = (t: string) => t.replace(ASCII_UPPER, (c) => c.toLowerCase());
	let out = text;
	for (const address of addresses) {
		const needle = fold(address);
		const stand = `<an address at ${domainOf(address)}>`;
		for (
			let at = fold(out).indexOf(needle);
			at !== -1;
			at = fold(out).indexOf(needle, at + stand.length)
		) {
			out = out.slice(0, at) + stand + out.slice(at + address.length);
		}
	}
	return out;
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
			"plugin:activate": { handler: async (_event, ctx) => schedulePrune(ctx) },
			cron: {
				handler: async (event, ctx) => {
					if (event.name !== PRUNE_TASK) return;
					const pruned = await pruneBudgets(ctx.kv, new Date());
					ctx.log.info("sending budget pruned", pruned);
				},
			},
		},
		routes: {
			// A site whose provider was turned on in its database never ran
			// plugin:activate, so reading the status schedules the prune too.
			status: {
				handler: async (ctx) => {
					await schedulePrune(ctx);
					return status(ctx);
				},
			},
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
