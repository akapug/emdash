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
 * - With `broker`, no message is sent from this Worker at all: after the
 *   checks here and the site's own budget, it is handed to the site's mail
 *   broker (a Worker of its own, `@emdash-cms/cloudflare/auth-mail/worker`,
 *   the only one with the send_email bindings and the account's mail-budget
 *   tokens) as a fixed envelope (to, cc, subject, text, html, reply-to) with
 *   this site's generation capability and a request id. The broker checks the
 *   capability (only its active generation's counts), the envelope and every
 *   recipient against its own list, takes the place in the account's budget,
 *   and sends. The Worker holds no send_email binding and no budget token. A
 *   missing binding or capability, a refusal or any error sends nothing; a
 *   call that throws is asked once more with the same request id, which the
 *   broker answers as the first (it never sends one request id twice).
 * - A log names a recipient's domain, never the address, and an error the
 *   binding throws has every address replaced by its domain, in any letter
 *   case, in its message, its stack and its causes (EmDash's scrubAddresses).
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
import { definePlugin, describeRedacted, redactAddresses, scrubAddresses } from "emdash";
import type { EmailDeliverEvent } from "emdash/plugin";

import { MAX_SUBJECT, displayName, domainOf, headerText, mailbox } from "./email-headers.js";
import { MAIL_BROKER_PROTOCOL } from "./mail-broker-protocol.js";

export { displayName, domainOf, headerText, mailbox } from "./email-headers.js";
export { MAIL_BROKER_PROTOCOL } from "./mail-broker-protocol.js";

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

	/**
	 * The site's mail broker: a Worker of its own that alone holds the
	 * send_email bindings and the account's mail-budget tokens, reached
	 * through a service binding with this site's generation capability, both
	 * read from the Worker's env. With it, a message is never sent from this
	 * Worker: once the checks here and the site's own budget pass, it is handed
	 * to the broker, which checks the capability, the envelope and every
	 * recipient, takes the account's budget and sends. `binding` is not used.
	 * A missing binding or capability, a refusal, or any error sends nothing,
	 * and the error says why.
	 */
	broker?: MailBrokerConfig;
}

/** Where the site's mail broker is (see {@link CloudflareEmailConfig.broker}). */
export interface MailBrokerConfig {
	/**
	 * Name of the service binding to the broker's Worker.
	 * @default "MAIL_BROKER"
	 */
	binding?: string;
	/**
	 * Name of the secret that holds this site's generation capability.
	 * @default "MAIL_BROKER_CAPABILITY"
	 */
	capability?: string;
	/**
	 * Name of the variable that holds this site's generation (a whole number the
	 * operator sets beside the capability), which the status route attests.
	 * @default "MAIL_GENERATION"
	 */
	generation?: string;
	/**
	 * How long a call to the broker may take. A send that has not answered by
	 * then is NOT known to be unsent (the broker may still send it), so it is
	 * reported as such and the site's own budget keeps its places.
	 * @default 5000
	 */
	timeoutMs?: number;
}

/** How long a call to the broker may take by default (see {@link MailBrokerConfig.timeoutMs}). */
export const BROKER_TIMEOUT_MS = 5_000;

/**
 * The broker as its service binding exposes it (RPC; the broker's protocol,
 * MAIL_BROKER_PROTOCOL). A send is `{ protocol, capability, requestId,
 * message }` and answers `{ protocol, status: "sent" | "refused" | "skipped",
 * why?, seq }`; the status is read-only.
 */
interface MailBrokerService {
	send(request: {
		protocol: number;
		capability: string;
		requestId: string;
		message: Record<string, unknown>;
	}): Promise<unknown>;
	status(request: { protocol: number; capability: string }): Promise<unknown>;
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

/**
 * What this provider enforces, as a marker a deployment can check a build for
 * before it turns the build's email on: headers checked before the binding,
 * the site's own budget, and every message through the site's mail broker
 * (`broker`). The status route answers it, so every Worker bundle that
 * carries this provider carries it as a string; a change to what the provider
 * enforces changes it. Embark's tenant tool checks the built dist for it at
 * install and the live status route for it when it turns email on.
 */
export const CLOUDFLARE_EMAIL_CAPABILITY =
	"emdash-cloudflare-email:checked-headers,site-budget,mail-broker;v=3";

/**
 * The version of the provider's attestation (the status route's
 * `attestation`): the machine-readable statement of what this build enforces
 * and what the site's mail broker says of this site's generation, which a
 * deployment reads before it turns the site's email on. A change to its shape
 * or meaning changes it.
 */
export const EMAIL_ATTESTATION_VERSION = 3;

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

/** The broker's binding and secret names and its timeout, or null when the config sets none. */
function brokerOf(config: CloudflareEmailConfig): Required<MailBrokerConfig> | null {
	if (!config.broker) return null;
	const timeoutMs = config.broker.timeoutMs;
	return {
		binding: config.broker.binding ?? "MAIL_BROKER",
		capability: config.broker.capability ?? "MAIL_BROKER_CAPABILITY",
		generation: config.broker.generation ?? "MAIL_GENERATION",
		timeoutMs: typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : BROKER_TIMEOUT_MS,
	};
}

/** The broker as a send uses it: the service, this site's capability and generation, how long a call may take. */
type Broker = {
	service: MailBrokerService;
	capability: string;
	generation: string | null;
	timeoutMs: number;
};

/** `call`'s answer, or `late` when it has not answered within `ms`. A call that fails rejects as it does. */
async function within<T>(call: Promise<T>, ms: number): Promise<{ answer: T } | { late: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<{ late: true }>((resolve) => {
		timer = setTimeout(resolve, ms, { late: true });
	});
	try {
		return await Promise.race([call.then((answer) => ({ answer })), late]);
	} finally {
		clearTimeout(timer);
	}
}

/** The broker and this site's capability from the env, or why either is missing. */
function brokerIn(
	env: Record<string, unknown>,
	names: Required<MailBrokerConfig>,
): Broker | { missing: string } {
	const service = env[names.binding];
	const capability = env[names.capability];
	const generation = env[names.generation];
	const callable =
		(typeof service === "object" || typeof service === "function") &&
		service !== null &&
		typeof Reflect.get(service, "send") === "function" &&
		typeof Reflect.get(service, "status") === "function";
	if (!callable) {
		return {
			missing: `the site's mail broker has no service binding "${names.binding}" in this Worker, so nothing is sent (bind the broker's Worker as a service)`,
		};
	}
	if (typeof capability !== "string" || !capability.trim()) {
		return {
			missing: `this Worker has no generation capability for the mail broker: the secret "${names.capability}" is not set, so nothing is sent`,
		};
	}
	return {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- checked above: send and status are callable
		service: service as MailBrokerService,
		capability: capability.trim(),
		generation: typeof generation === "string" && generation.trim() ? generation.trim() : null,
		timeoutMs: names.timeoutMs,
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** SHA-256 of `text`, hex. */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hand one message to the broker: its envelope, this site's capability and a
 * request id. `sent`, `refused` (the broker said why; nothing was sent), or
 * `unknown` (no answer that says either, or the broker's own `unknown` for a
 * first attempt that never finished: the broker may have sent it). A call
 * that throws is asked once more with the same request id, which the broker
 * answers as it answered the first: one request id is never sent twice.
 */
async function sendThroughBroker(
	broker: Broker,
	message: Record<string, unknown>,
	recipients: readonly string[],
): Promise<{ sent: true } | { refused: string } | { unknown: string }> {
	const request = {
		protocol: MAIL_BROKER_PROTOCOL,
		capability: broker.capability,
		requestId: crypto.randomUUID(),
		message,
	};
	let got: { answer: unknown } | { late: true };
	try {
		try {
			got = await within(broker.service.send(request), broker.timeoutMs);
		} catch {
			got = await within(broker.service.send(request), broker.timeoutMs);
		}
	} catch (error) {
		return {
			unknown: `the mail broker could not be asked (${describeRedacted(error, recipients)}), so whether it was sent is not known`,
		};
	}
	if ("late" in got) {
		return {
			unknown: `the mail broker did not answer within ${broker.timeoutMs} ms, so whether it was sent is not known`,
		};
	}
	const a = got.answer;
	if (!isRecord(a) || a.protocol !== MAIL_BROKER_PROTOCOL) {
		return {
			unknown: `the mail broker answered in protocol ${JSON.stringify(isRecord(a) ? (a.protocol ?? null) : null)}, and this provider speaks ${MAIL_BROKER_PROTOCOL}`,
		};
	}
	if (a.status === "sent") return { sent: true };
	if ((a.status === "refused" || a.status === "skipped") && typeof a.why === "string") {
		return { refused: redactAddresses(a.why, recipients) };
	}
	// A retry of a send whose first attempt never finished in the broker: it may have gone.
	if (a.status === "unknown" && typeof a.why === "string") {
		return {
			unknown: `the mail broker says it is not known whether it was sent (${redactAddresses(a.why, recipients)})`,
		};
	}
	return { unknown: "the mail broker answered neither sent nor refused" };
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
	const brokerNames = brokerOf(config);

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
		if (message.replyTo !== undefined && !mailbox(message.replyTo)) {
			ctx.log.warn("reply-to dropped: it is not one plain address", { source });
		}
		const replyTo = mailbox(message.replyTo) ?? (await siteReplyTo(ctx)) ?? mailbox(config.replyTo);

		if (brokerNames) {
			// Through the site's mail broker: this Worker sends nothing itself.
			const broker = brokerIn(env, brokerNames);
			if ("missing" in broker) {
				ctx.log.warn("email refused: no mail broker", { source, why: broker.missing });
				throw new Error(`[cloudflare-email] refusing to send: ${broker.missing}`);
			}
			const budget = await takeBudget(ctx.kv, source, [to, ...cc], limits, now());
			if ("refused" in budget) {
				ctx.log.warn("email refused: sending budget spent", { source, why: budget.refused });
				throw new Error(`[cloudflare-email] refusing to send: ${budget.refused}`);
			}
			const recipients = [to, ...cc, ...(replyTo ? [replyTo] : [])];
			const got = await sendThroughBroker(
				broker,
				{
					to,
					subject,
					text: message.text,
					...(message.html ? { html: message.html } : {}),
					...(cc.length ? { cc } : {}),
					...(replyTo ? { replyTo } : {}),
				},
				recipients,
			);
			if ("refused" in got) {
				// Only a send the broker made spends the site's budget.
				await refundBudget(ctx.kv, budget.taken);
				ctx.log.warn("email refused: the mail broker refused it", { source, why: got.refused });
				throw new Error(
					`[cloudflare-email] refusing to send: the mail broker refused it: ${got.refused}`,
				);
			}
			if ("unknown" in got) {
				// It may have gone: the site's places stay taken, which refuses sooner, never later.
				ctx.log.warn("email not known to be sent", { source, why: got.unknown });
				throw new Error(`[cloudflare-email] ${got.unknown}`);
			}
			ctx.log.info("email delivered via the site's mail broker", {
				toDomain: domainOf(to),
				...(cc.length ? { cc: cc.length } : {}),
				subject,
				source,
			});
			return;
		}

		const binding = bindingOf(env, bindingName);
		if (!binding) {
			throw new Error(
				`[cloudflare-email] send_email binding "${bindingName}" not found — ` +
					`declare it in the wrangler config ("send_email": [{ "name": "${bindingName}" }]).`,
			);
		}

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
			throw scrubAddresses(error, [to, ...cc, ...(replyTo ? [replyTo] : [])]);
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

/**
 * `text` with each of `addresses` (in any case), and every other address in
 * it, replaced by its domain: an error the binding throws may name its
 * recipient, and it is logged. EmDash's redactAddresses, the one redaction the
 * email pipeline and the forms plugin use too.
 */
export function withoutAddresses(text: string, addresses: readonly string[]): string {
	return redactAddresses(text, addresses);
}

/**
 * What the provider would send with, for the admin and for an operator's
 * import report: the sender, whether the Worker has what it sends through
 * (the send_email binding, or with `broker` the broker's service binding and
 * this site's capability), where replies go when a message names nobody. It
 * sends nothing.
 *
 * `attestation` (EMAIL_ATTESTATION_VERSION) is what a deployment checks
 * before it turns the site's email on: the provider and its capability
 * marker, what this build guarantees (headers checked before anything is
 * sent, the site's own budget, every message through the site's mail broker,
 * a cancelled send reported as cancelled, addresses redacted from what is
 * logged), and, with `broker`, the broker protocol this provider speaks, the
 * generation this Worker was given (MAIL_GENERATION), the SHA-256 of its
 * capability, and the broker's LIVE status for that capability: whether it is
 * the broker's active or staged generation's, the site and deployment the
 * broker is configured as, and, for its generation, the capability's and the
 * two budget tokens' hashes and the account's budget's report of each lane
 * (the tenant, lane, generation and state each token is registered to). It
 * never carries the capability, a token or a recipient, and sends, takes and
 * refunds nothing.
 *
 * @internal
 */
export function createCloudflareEmailStatus(
	config: CloudflareEmailConfig,
	loadEnv: () => Promise<Record<string, unknown>> = loadWorkerEnv,
) {
	const bindingName = config.binding ?? "EMAIL";
	const from = typeof config.from === "string" ? { email: config.from } : config.from;
	const names = brokerOf(config);
	return async (ctx: PluginContext) => {
		const env = await loadEnv().catch((): Record<string, unknown> => ({}));
		const site = await siteReplyTo(ctx);
		const broker = names ? brokerIn(env, names) : null;
		const ready = Boolean(broker && !("missing" in broker));
		return {
			provider: "cloudflare-email",
			capability: CLOUDFLARE_EMAIL_CAPABILITY,
			from: from.email,
			senderName: from.name ? "configured" : "site title",
			binding: names
				? { name: names.binding, present: ready }
				: { name: bindingName, present: Boolean(bindingOf(env, bindingName)) },
			replyTo: site ? "site" : mailbox(config.replyTo) ? "configured" : null,
			limits: limitsOf(config),
			// Whether sends go through the broker, and whether this Worker has what that needs; never the capability.
			broker: names
				? {
						binding: names.binding,
						capability: names.capability,
						ready,
						...(broker && "missing" in broker ? { why: broker.missing } : {}),
					}
				: null,
			attestation: {
				v: EMAIL_ATTESTATION_VERSION,
				provider: "cloudflare-email",
				capability: CLOUDFLARE_EMAIL_CAPABILITY,
				guarantees: {
					headersChecked: true,
					siteBudget: true,
					broker: names !== null,
					cancellation: "reported",
					redaction: "addresses",
				},
				broker: names
					? {
							protocol: MAIL_BROKER_PROTOCOL,
							ready,
							generation: broker && !("missing" in broker) ? broker.generation : null,
							capabilityHash:
								broker && !("missing" in broker) ? await sha256Hex(broker.capability) : null,
							live:
								broker && !("missing" in broker)
									? await liveBroker(broker)
									: {
											ok: false,
											why: (broker && "missing" in broker && broker.missing) || "not asked",
										},
						}
					: null,
			},
		};
	};
}

const HEX64 = /^[0-9a-f]{64}$/;
const text = (v: unknown) => (typeof v === "string" ? v : null);
const whole = (v: unknown) => (Number.isSafeInteger(v) ? Number(v) : null);

/** One lane's budget report, as the broker relays it: only these fields, each of its type. */
function laneOf(v: unknown) {
	if (!isRecord(v)) return { ok: false as const, why: "no report" };
	if (v.ok !== true) return { ok: false as const, why: text(v.why) ?? "not ok" };
	const caps = isRecord(v.caps)
		? Object.fromEntries(
				Object.entries(v.caps).filter(
					(e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]),
				),
			)
		: null;
	return {
		ok: true as const,
		tenant: text(v.tenant),
		lane: text(v.lane),
		generation: whole(v.generation),
		state: text(v.state),
		caps,
	};
}

/**
 * The broker's live status for this site's capability, within the timeout,
 * read strictly (no field passes through unread): `{ ok: true, ... }` in the
 * broker's protocol with its marker, or `{ ok: false, why }` for an error, no
 * answer in time, another protocol, or no marker.
 */
async function liveBroker(broker: Broker) {
	let answer: unknown;
	try {
		const got = await within(
			broker.service.status({ protocol: MAIL_BROKER_PROTOCOL, capability: broker.capability }),
			broker.timeoutMs,
		);
		if ("late" in got)
			return { ok: false as const, why: `it did not answer within ${broker.timeoutMs} ms` };
		answer = got.answer;
	} catch (error) {
		return { ok: false as const, why: `it could not be asked (${describeRedacted(error)})` };
	}
	if (!isRecord(answer) || answer.protocol !== MAIL_BROKER_PROTOCOL) {
		return {
			ok: false as const,
			why: `it answered in protocol ${JSON.stringify(isRecord(answer) ? (answer.protocol ?? null) : null)}, not ${MAIL_BROKER_PROTOCOL}`,
		};
	}
	if (typeof answer.marker !== "string")
		return { ok: false as const, why: "its status carries no marker" };
	const capability = answer.capability;
	const generations = isRecord(answer.generations) ? answer.generations : {};
	const hashes = isRecord(answer.tokenHashes) ? answer.tokenHashes : {};
	const send = isRecord(answer.send) ? answer.send : {};
	const budget = isRecord(answer.budget) ? answer.budget : {};
	return {
		ok: true as const,
		marker: answer.marker,
		seq: whole(answer.seq),
		tenant: text(answer.tenant),
		deployment: text(answer.deployment),
		capability: capability === "active" || capability === "staged" ? capability : "unknown",
		generations: { active: whole(generations.active), staged: whole(generations.staged) },
		generation: whole(answer.generation),
		capabilityHash:
			typeof answer.capabilityHash === "string" && HEX64.test(answer.capabilityHash)
				? answer.capabilityHash
				: null,
		tokenHashes: {
			plugin: typeof hashes.plugin === "string" && HEX64.test(hashes.plugin) ? hashes.plugin : null,
			system: typeof hashes.system === "string" && HEX64.test(hashes.system) ? hashes.system : null,
		},
		send: { plugin: send.plugin === true, system: send.system === true },
		site: answer.site === true,
		recipients: whole(answer.recipients),
		budget: { plugin: laneOf(budget.plugin), system: laneOf(budget.system) },
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
