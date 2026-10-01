/**
 * Email subscriptions to a site's new posts: what the plugin's routes, hook
 * and cron do, over its storage, its KV and the site's email.
 *
 * A visitor gives an address on the site's form. It is stored PENDING with
 * the consent it came with (the site it was given to, the page, the time) and
 * nothing else about them, and a confirmation email is queued. The link in
 * that email CONFIRMS it; every email carries a link that UNSUBSCRIBES it,
 * which deletes the address. Each post published afterwards queues one
 * message for each confirmed address.
 *
 * Links are signed: each carries the subscriber's id (a keyed hash of the
 * address, never the address) and an HMAC of the action and the id under a
 * secret the site keeps in the plugin's KV. Nothing about a subscriber can be
 * read or changed without one.
 *
 * THE MAIL SEAM. Every message the plugin sends goes out through `deliver`,
 * one call to `ctx.email.send()`: the same path the forms plugin's
 * notifications take, so whatever the site does with a plugin's mail (its
 * provider, a broker that budgets it) holds for these too. While the site
 * has no email provider, `ctx.email` is undefined: messages wait in the
 * outbox, and the visitor is told that no email was sent. The cron drains the
 * outbox once the site can send; whatever queues a message puts the cron on
 * the schedule (ensureDrain).
 */

import type { KVAccess, LogAccess, PluginContext, StorageCollection } from "emdash";

import { parseCsv } from "./csv.js";

/** The site's email, as a plugin with `email:send` reaches it (`ctx.email`). */
type EmailAccess = NonNullable<PluginContext["email"]>;
/** The plugin's scheduled tasks (`ctx.cron`). */
type CronAccess = NonNullable<PluginContext["cron"]>;

// ─── Types ───────────────────────────────────────────────────────

/** A subscriber: the address and the consent it was given with. */
export interface Subscriber {
	/** Where confirmations and new posts go, lowercased. */
	email: string;
	status: "pending" | "confirmed";
	createdAt: string;
	confirmedAt?: string;
	/** How the address was given, to which site, on which page, and when. */
	consent: {
		/** On this site's form, or brought over with a list another platform kept. */
		source: "form" | "import";
		/** An imported address: the platform whose list it came from, when the file says (Substack's does). */
		from?: string;
		/** The site it was given to: its host. */
		site: string;
		/** The page the form was on (a path). */
		page?: string;
		at: string;
		/** An imported address: when the list it came from says it subscribed. */
		subscribedAt?: string;
	};
	/** The form's id on the page, which the confirmation sends the visitor back to. */
	fragment?: string;
}

/** A message waiting to be sent: the subscriber's id and what to say, never a copy of the address. */
export interface OutboxMessage {
	kind: "confirm" | "post";
	subscriber: string;
	status: "queued" | "failed";
	createdAt: string;
	attempts: number;
	/** A new post: what the message says of it. */
	post?: { id: string; title: string; url: string; excerpt: string };
}

/** What the plugin reaches. `email` is undefined while the site sends no email. */
export interface SubscriptionsEnv {
	subscribers: StorageCollection<Subscriber>;
	outbox: StorageCollection<OutboxMessage>;
	kv: KVAccess;
	email?: EmailAccess;
	/** The plugin's scheduled tasks; undefined where the runtime runs none. */
	cron?: CronAccess;
	site: { name: string; url: string };
	/** An absolute URL on the site. */
	url(path: string): string;
	log: LogAccess;
	now(): Date;
}

/** The site's host, from its address; empty when it has none. */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

/** Where the plugin's public routes are. */
export const PLUGIN_ID = "emdash-subscriptions";
export const ROUTES = `/_emdash/api/plugins/${PLUGIN_ID}`;

/**
 * What a try did, as the site's sign-up says it (the template's
 * WP_SHELL_SUBSCRIBE_MESSAGES): `sent` a confirmation email went out, `saved`
 * the site cannot send email yet and none did, `queued` sending failed and it
 * waits in the outbox.
 */
export const SUBSCRIBE_STATUSES = [
	"sent",
	"saved",
	"queued",
	"pending",
	"pending_saved",
	"already",
	"invalid_email",
	"error",
	"confirmed",
	"unsubscribed",
	"invalid_link",
] as const;
export type SubscribeStatus = (typeof SUBSCRIBE_STATUSES)[number];

// ─── Addresses, pages and signed links ───────────────────────────

/** An address a message can go to: one @, no white space or markup, a dot in the domain, 254 characters at most. */
const EMAIL = /^[^\s@<>"'(),;:\\[\]]{1,64}@[^\s@<>"'(),;:\\[\]]+\.[^\s@<>"'(),;:\\[\]]+$/;

export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/** A path on the site to send the visitor back to: one of its own, with no query or fragment. */
const PAGE = /^\/(?![/\\])[^\s?#\\]{0,500}$/;
export const pageOf = (value: unknown): string =>
	typeof value === "string" && PAGE.test(value) ? value : "/";

/** A form's id to send the visitor back to. */
const FRAGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,100}$/;
export const fragmentOf = (value: unknown): string | undefined =>
	typeof value === "string" && FRAGMENT.test(value) ? value : undefined;

/** Where a visitor goes after a try: the page, what the try did, and the form. */
export function backTo(page: string, status: SubscribeStatus, fragment?: string): string {
	return `${page}?subscribe=${status}${fragment ? `#${fragment}` : ""}`;
}

const SECRET_KEY = "state:secret";

/** The key the site signs its links with, made once. */
async function secretOf(env: SubscriptionsEnv): Promise<string> {
	const have = await env.kv.get<string>(SECRET_KEY);
	if (have) return have;
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	await env.kv.compareAndSet(SECRET_KEY, null, hex(bytes));
	// Two first requests at once: the one stored is the key.
	const stored = await env.kv.get<string>(SECRET_KEY);
	if (!stored) throw new Error("the subscriptions key could not be stored");
	return stored;
}

const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(env: SubscriptionsEnv, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(await secretOf(env)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
	);
}

/** A subscriber's id: a keyed hash of the address, so a link names the subscriber and not the address. */
export async function subscriberId(env: SubscriptionsEnv, email: string): Promise<string> {
	return (await hmac(env, `subscriber:${email}`)).slice(0, 32);
}

/** The signature a link carries for one action on one subscriber. */
export async function linkToken(
	env: SubscriptionsEnv,
	action: "confirm" | "unsubscribe",
	id: string,
): Promise<string> {
	return (await hmac(env, `${action}:${id}`)).slice(0, 32);
}

const SUBSCRIBER_ID = /^[0-9a-f]{32}$/;

/** Whether `token` is the one for `action` on `id`, compared in constant time. */
async function tokenHolds(
	env: SubscriptionsEnv,
	action: "confirm" | "unsubscribe",
	id: unknown,
	token: unknown,
): Promise<boolean> {
	if (typeof id !== "string" || typeof token !== "string" || !SUBSCRIBER_ID.test(id)) return false;
	const want = await linkToken(env, action, id);
	if (token.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
	return diff === 0;
}

async function link(env: SubscriptionsEnv, action: "confirm" | "unsubscribe", id: string) {
	return env.url(`${ROUTES}/${action}?s=${id}&t=${await linkToken(env, action, id)}`);
}

// ─── The outbox and the seam ─────────────────────────────────────

/** The task that drains the outbox, and how often it runs. */
export const DRAIN_TASK = "drain";
export const DRAIN_SCHEDULE = "*/5 * * * *";

/**
 * Put the outbox's drain on the schedule, once. EmDash runs `plugin:activate`
 * only when a plugin is turned on in the admin, never for one the site's
 * config declares, so a message queued while the site cannot send would wait
 * for the next new post. Whatever queues a message calls this.
 */
async function ensureDrain(env: SubscriptionsEnv): Promise<void> {
	if (!env.cron) return;
	// The message is stored whatever happens here: a failure is the site's to see, not the visitor's.
	try {
		const tasks = await env.cron.list();
		if (!tasks.some((t) => t.name === DRAIN_TASK))
			await env.cron.schedule(DRAIN_TASK, { schedule: DRAIN_SCHEDULE });
	} catch (error) {
		env.log.warn("the outbox's drain could not be scheduled", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Tries before a message is given up on. */
const MAX_ATTEMPTS = 5;
/** Messages one drain sends at most. */
const DRAIN_BATCH = 50;

/** THE SEAM: every message this plugin sends goes out here, through the site's email. */
async function deliver(
	email: EmailAccess,
	message: { to: string; subject: string; text: string; html: string },
): Promise<void> {
	await email.send(message);
}

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A message's words, in plain text and in HTML, for a subscriber. */
async function compose(
	env: SubscriptionsEnv,
	m: OutboxMessage,
	id: string,
): Promise<{ subject: string; text: string; html: string }> {
	const site = env.site.name || hostOf(env.site.url);
	const leave = await link(env, "unsubscribe", id);
	if (m.kind === "confirm") {
		const confirmUrl = await link(env, "confirm", id);
		const words = [
			"Howdy.",
			`You recently followed ${site}'s posts. This means you will receive each new post by email.`,
			"To activate, click confirm below. If you believe this is an error, ignore this message and we'll never bother you again.",
		];
		return {
			subject: `Confirm your subscription to ${site}`,
			text: `${words.join("\n\n")}\n\nConfirm: ${confirmUrl}\n`,
			html: `${words.map((w) => `<p>${escapeHtml(w)}</p>`).join("")}<p><a href="${escapeHtml(confirmUrl)}">Confirm</a></p>`,
		};
	}
	const post = m.post!;
	const url = env.url(post.url);
	const footer = `You are receiving this because you subscribed to ${site}.`;
	return {
		subject: `[${site}] ${post.title}`,
		text: `${post.title}\n\n${post.excerpt}\n\nRead more: ${url}\n\n--\n${footer}\nUnsubscribe: ${leave}\n`,
		html:
			`<h2><a href="${escapeHtml(url)}">${escapeHtml(post.title)}</a></h2>` +
			(post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : "") +
			`<p><a href="${escapeHtml(url)}">Read more</a></p>` +
			`<hr><p>${escapeHtml(footer)} <a href="${escapeHtml(leave)}">Unsubscribe</a></p>`,
	};
}

/** Put one message in the outbox, once: a second of the same kind for the same subscriber and post is the first. */
async function enqueue(
	env: SubscriptionsEnv,
	id: string,
	kind: OutboxMessage["kind"],
	post?: OutboxMessage["post"],
): Promise<string> {
	const key = kind === "confirm" ? `confirm:${id}` : `post:${post!.id}:${id}`;
	await env.outbox.compareAndSet(key, null, {
		kind,
		subscriber: id,
		status: "queued",
		createdAt: env.now().toISOString(),
		attempts: 0,
		...(post ? { post } : {}),
	});
	return key;
}

/** Send one queued message; true when it went. A message whose subscriber is gone goes with them. */
async function sendOne(env: SubscriptionsEnv, key: string): Promise<boolean> {
	const email = env.email;
	const m = await env.outbox.get(key);
	if (!email || !m || m.status !== "queued") return false;
	const sub = await env.subscribers.get(m.subscriber);
	if (!sub || (m.kind === "post" && sub.status !== "confirmed")) {
		await env.outbox.delete(key);
		return false;
	}
	try {
		await deliver(email, { to: sub.email, ...(await compose(env, m, m.subscriber)) });
		await env.outbox.delete(key);
		return true;
	} catch (error) {
		const attempts = m.attempts + 1;
		await env.outbox.put(key, {
			...m,
			attempts,
			status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
		});
		// A provider's error may name the recipient: the log never holds an address.
		const why = error instanceof Error ? error.message : String(error);
		env.log.warn("a subscription email was not sent", {
			kind: m.kind,
			attempts,
			error: why.split(sub.email).join("<address>"),
		});
		return false;
	}
}

/**
 * Send what waits in the outbox, oldest first, a batch at a time: nothing
 * while the site sends no email. Returns how many went.
 */
export async function drain(env: SubscriptionsEnv, limit = DRAIN_BATCH): Promise<number> {
	if (!env.email) return 0;
	const { items } = await env.outbox.query({
		where: { status: "queued" },
		orderBy: { createdAt: "asc" },
		limit,
	});
	let sent = 0;
	for (const { id } of items) if (await sendOne(env, id)) sent++;
	return sent;
}

// ─── Subscribe, confirm, unsubscribe ─────────────────────────────

/** A visitor's try on the site's form: what it did, as a status the page says. */
export async function subscribe(
	env: SubscriptionsEnv,
	input: { email: unknown; page: string; fragment?: string; honeypot?: unknown },
): Promise<SubscribeStatus> {
	// A box no person fills: a bot is told what a person would be, and nothing is stored.
	if (typeof input.honeypot === "string" && input.honeypot !== "")
		return env.email ? "sent" : "saved";
	const email = normalizeEmail(input.email);
	if (!email) return "invalid_email";
	const id = await subscriberId(env, email);
	const now = env.now().toISOString();
	const made = await env.subscribers.compareAndSet(id, null, {
		email,
		status: "pending",
		createdAt: now,
		consent: { source: "form", site: hostOf(env.site.url), page: input.page, at: now },
		...(input.fragment ? { fragment: input.fragment } : {}),
	});
	if (!made.applied) {
		const have = await env.subscribers.get(id);
		if (have?.status === "confirmed") return "already";
		// "Check your inbox" is true only of a confirmation that went. One that waits (the site
		// could not send, or sending failed) is tried again now, and the visitor told what happened.
		const key = `confirm:${id}`;
		const waiting = await env.outbox.get(key);
		if (!waiting) return env.email ? "pending" : "pending_saved";
		if (waiting.status === "failed")
			await env.outbox.put(key, { ...waiting, status: "queued", attempts: 0 });
		await ensureDrain(env);
		if (!env.email) return "pending_saved";
		return (await sendOne(env, key)) ? "sent" : "queued";
	}
	const key = await enqueue(env, id, "confirm");
	await ensureDrain(env);
	if (!env.email) return "saved";
	return (await sendOne(env, key)) ? "sent" : "queued";
}

/**
 * Where a link sends the visitor back to: the page they subscribed on, which
 * has the sign-up that says what the link did, and its form.
 */
export interface LinkOutcome {
	status: SubscribeStatus;
	page: string;
	fragment?: string;
}

const outcome = (status: SubscribeStatus, sub?: Subscriber | null): LinkOutcome => ({
	status,
	page: sub?.consent.page ? pageOf(sub.consent.page) : "/",
	...(sub?.fragment ? { fragment: sub.fragment } : {}),
});

/** The confirmation link: the subscriber is confirmed, once. */
export async function confirm(
	env: SubscriptionsEnv,
	query: { s?: unknown; t?: unknown },
): Promise<LinkOutcome> {
	if (!(await tokenHolds(env, "confirm", query.s, query.t))) return outcome("invalid_link");
	const id = query.s as string;
	const sub = await env.subscribers.get(id);
	if (!sub) return outcome("invalid_link");
	if (sub.status !== "confirmed")
		await env.subscribers.put(id, {
			...sub,
			status: "confirmed",
			confirmedAt: env.now().toISOString(),
		});
	await env.outbox.delete(`confirm:${id}`);
	return outcome("confirmed", sub);
}

/** The unsubscribe link: the address is deleted, with every message waiting for it. */
export async function unsubscribe(
	env: SubscriptionsEnv,
	query: { s?: unknown; t?: unknown },
): Promise<LinkOutcome> {
	if (!(await tokenHolds(env, "unsubscribe", query.s, query.t))) return outcome("invalid_link");
	const id = query.s as string;
	const sub = await env.subscribers.get(id);
	await env.subscribers.delete(id);
	for (;;) {
		const { items } = await env.outbox.query({ where: { subscriber: id }, limit: 100 });
		if (items.length === 0) break;
		await env.outbox.deleteMany(items.map((i) => i.id));
	}
	return outcome("unsubscribed", sub);
}

/** How many confirmed subscribers the site has: the count its sign-up says. */
export const confirmedCount = (env: Pick<SubscriptionsEnv, "subscribers">) =>
	env.subscribers.count({ status: "confirmed" });

// ─── New posts ───────────────────────────────────────────────────

/**
 * How recent a post's publication must be for it to go out. A post imported
 * with the date WordPress published it, or published backdated, is old news
 * to its subscribers, and WordPress.com never mailed it.
 */
export const NEW_POST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A published post, as the publish hook hands it over. */
export interface PublishedPost {
	id: string;
	slug: string | null;
	title: string;
	excerpt: string;
	publishedAt: Date | null;
}

const WHITESPACE = /\s+/;

/** A post's excerpt: its own, or its first 55 words, WordPress's default length. */
export function excerptOf(data: Record<string, unknown>): string {
	if (typeof data.excerpt === "string" && data.excerpt.trim() !== "") return data.excerpt.trim();
	const words = portableText(data.content).split(WHITESPACE).filter(Boolean);
	return words.length > 55 ? `${words.slice(0, 55).join(" ")} [\u2026]` : words.join(" ");
}

/** Portable Text's words: each text block's spans. */
function portableText(blocks: unknown): string {
	if (!Array.isArray(blocks)) return typeof blocks === "string" ? blocks : "";
	return blocks
		.flatMap((b: unknown) => {
			const block = b as { _type?: unknown; children?: unknown };
			return block?._type === "block" && Array.isArray(block.children)
				? block.children.map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : ""))
				: [];
		})
		.join(" ");
}

/**
 * A post was published: one message for each confirmed subscriber, once per
 * post, and only for a post published now (NEW_POST_WINDOW_MS). Returns how
 * many were queued; they go out with the next drain, and at once when the
 * site can send.
 */
export async function queueNewPost(
	env: SubscriptionsEnv,
	post: PublishedPost,
	postPath: (slug: string) => string,
): Promise<number> {
	const at = post.publishedAt?.getTime();
	if (!post.slug || at === undefined || Number.isNaN(at)) return 0;
	if (Math.abs(env.now().getTime() - at) > NEW_POST_WINDOW_MS) return 0;
	// Once per post: a post unpublished and published again is not new.
	const marker = await env.kv.compareAndSet(
		`state:announced:${post.id}`,
		null,
		env.now().toISOString(),
	);
	if (!marker.applied) return 0;
	const snapshot = {
		id: post.id,
		title: post.title,
		url: postPath(post.slug),
		excerpt: post.excerpt,
	};
	let queued = 0;
	let cursor: string | undefined;
	do {
		const page = await env.subscribers.query({
			where: { status: "confirmed" },
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		for (const { id } of page.items) {
			await enqueue(env, id, "post", snapshot);
			queued++;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	if (queued > 0) await ensureDrain(env);
	return queued;
}

// ─── Status, for the admin ───────────────────────────────────────

export async function stats(env: SubscriptionsEnv) {
	const [pending, confirmed, queued, failed] = await Promise.all([
		env.subscribers.count({ status: "pending" }),
		env.subscribers.count({ status: "confirmed" }),
		env.outbox.count({ status: "queued" }),
		env.outbox.count({ status: "failed" }),
	]);
	return { pending, confirmed, queued, failed, mail: env.email !== undefined };
}

// ─── Importing the list WordPress kept ───────────────────────────

/** The most rows one import reads. */
export const IMPORT_MAX_ROWS = 50_000;

/** A header that names the address column. */
const EMAIL_HEADER = /^(?:e-?mail(?:[ _-]?address)?|subscriber[ _-]?e-?mail|user[ _-]?e-?mail)$/i;
/** A header that names when the address subscribed. */
const DATE_HEADER = /date|subscribed|created|since/i;
/** A header that names the subscription's state. */
const STATUS_HEADER = /^(?:status|state|subscription[ _-]?status)$/i;
/** States that are a subscription: anything else in a status column is not imported. */
const SUBSCRIBED = /^(?:|active|subscribed|confirmed|free|paid|email[ _-]?subscriber)$/i;
/** A column saying the reader turned email off (Substack's `email_disabled`): a true value there is no consent. */
const DISABLED_HEADER = /^(?:e-?mail[ _-]?disabled|unsubscribed)$/i;
/** A paid plan's columns: Substack's `active_subscription`, and its `plan`. */
const ACTIVE_HEADER = /^active[ _-]?subscription$/i;
const PLAN_HEADER = /^plan$/i;
/** Substack writes a free reader's plan as `other`. */
const FREE_PLAN = /^(?:|other|free|none)$/i;
const TRUE = /^(?:true|yes|y|1)$/i;
const FALSE = /^(?:false|no|n|0)$/i;
const TYPE_HEADER = /^type$/i;
const SUBSTACK_TYPE = /^(?:free|paid|comp|gift|founding)$/i;
const PAID_TYPE = /^(?:paid|founding)$/i;
const SUBSTACK_DISABLED_HEADER = /^e-?mail[ _-]?disabled$/i;
const DIGEST_HEADER = /^digest[ _-]?enabled$/i;
/** The address Substack puts in place of a reader who asked for their data to be deleted. */
const DELETION_REQUEST = /@deletion-request\.substack\.com$/i;

/** A date and time with no zone, as exports write them: taken as UTC. */
const NAIVE_DATE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/;
/** A date and time with its zone. */
const ZONED_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** A row's field in a column, trimmed; "" for a column the file does not have. */
const cell = (row: string[], at: number): string => (at >= 0 ? (row[at] ?? "").trim() : "");

/** When a file's date says, as an ISO string; none for a date it does not write as ISO 8601. */
function dateOf(text: string): string | undefined {
	const t = text.trim();
	const naive = NAIVE_DATE.exec(t);
	const at = naive
		? new Date(`${naive[1]}T${naive[2] ?? "00:00"}Z`)
		: ZONED_DATE.test(t)
			? new Date(t)
			: null;
	return at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined;
}

/** What an import did, in counts: never an address. */
export interface ImportReport {
	/** The file's data rows read. */
	rows: number;
	/** Addresses the site did not have, now confirmed subscribers. */
	imported: number;
	/** Addresses a visitor had given on this site's form and not confirmed, now confirmed by the list. */
	confirmed: number;
	/** Addresses the site already had as confirmed subscribers. */
	already: number;
	/** Rows with no address a message can go to. */
	invalid: number;
	/** Rows the file's status column says are not subscribed, by that status. */
	notSubscribed: Record<string, number>;
	/**
	 * Rows the file marks as paying (an active subscription, paid/founding type,
	 * or a paid plan in Substack's data export), whether or not they get email:
	 * this list moves addresses, not
	 * payments, so a person has to move those.
	 */
	paid: number;
	/** The platform the file is from, when its columns say (Substack's do). */
	from?: string;
	/** Why nothing was read, when nothing was. */
	refused?: string;
}

/**
 * The subscriber list a site kept on another platform, as the CSV its export
 * writes: WordPress.com's (Jetpack keeps the list there) or the email_list
 * file in Substack's export. A header line names an address column (`email`,
 * `email_address`, ...), and, when it has them, a date and a status column.
 * Each address becomes a confirmed subscriber, its consent recorded as
 * brought over (and from which platform, when the file says). A row is not
 * imported when its status says it is not subscribed (unsubscribed,
 * pending, blocked), when it says the reader turned email off (Substack's
 * `email_disabled`), when digests are enabled, or when it is the address
 * Substack leaves for a reader who asked to be deleted. Substack-shaped lists
 * need explicit email-on and digest-off preferences; missing or unknown values
 * do not authorize every-post mail. Paying readers are counted: their payments do not
 * move with the list. Nothing is sent to anyone.
 */
export async function importSubscribers(env: SubscriptionsEnv, csv: string): Promise<ImportReport> {
	const report: ImportReport = {
		rows: 0,
		imported: 0,
		confirmed: 0,
		already: 0,
		invalid: 0,
		notSubscribed: {},
		paid: 0,
	};
	const rows = parseCsv(csv);
	let header = (rows[0] ?? []).map((h) => h.trim());
	let data = rows.slice(1);
	let emailAt = header.findIndex((h) => EMAIL_HEADER.test(h));
	// No header names it: the one column in which every row holds an address. When the first
	// line holds one there too, the file has no header at all, and its first line is an address.
	if (emailAt < 0) {
		const holding = (from: string[][]) =>
			header
				.map((_, i) => i)
				.filter((i) => from.length > 0 && from.every((r) => (r[i] ?? "").includes("@")));
		const bare = holding(rows);
		const columns = bare.length === 1 ? bare : holding(data);
		if (columns.length === 1) emailAt = columns[0]!;
		if (bare.length === 1) {
			data = rows;
			header = [];
		}
	}
	if (data.length > IMPORT_MAX_ROWS)
		return {
			...report,
			refused: `${data.length} rows, past the ${IMPORT_MAX_ROWS} one import reads`,
		};
	if (emailAt < 0)
		return {
			...report,
			refused: "no column of the file holds the addresses (a header named email or email_address)",
		};
	const dateAt = header.findIndex((h, i) => i !== emailAt && DATE_HEADER.test(h));
	const columns = (pattern: RegExp) => header.flatMap((h, i) => (pattern.test(h) ? [i] : []));
	const statusAts = columns(STATUS_HEADER);
	const disabledAts = columns(DISABLED_HEADER);
	const emailDisabledAts = columns(SUBSTACK_DISABLED_HEADER);
	const activeAt = header.findIndex((h) => ACTIVE_HEADER.test(h));
	const planAt = header.findIndex((h) => PLAN_HEADER.test(h));
	const typeAts = columns(TYPE_HEADER);
	const digestAts = columns(DIGEST_HEADER);
	const dataExport = emailDisabledAts.length > 0 && (activeAt >= 0 || planAt >= 0);
	const needsPreferences = emailDisabledAts.length > 0 || activeAt >= 0 || typeAts.length > 0;
	if (dataExport) report.from = "substack";
	const site = hostOf(env.site.url);
	const now = env.now().toISOString();
	const skip = (key: string) => {
		report.notSubscribed[key] = (report.notSubscribed[key] ?? 0) + 1;
	};
	for (const row of data) {
		report.rows++;
		const knownType = typeAts.length > 0 && typeAts.every((i) => SUBSTACK_TYPE.test(cell(row, i)));
		const from =
			dataExport || (knownType && emailDisabledAts.length > 0 && digestAts.length > 0)
				? "substack"
				: undefined;
		if (from) report.from = from;
		const paying =
			activeAt >= 0
				? TRUE.test(cell(row, activeAt))
				: typeAts.length > 0
					? typeAts.some((i) => PAID_TYPE.test(cell(row, i)))
					: dataExport && !FREE_PLAN.test(cell(row, planAt));
		if (paying) report.paid++;
		const rejectedState = statusAts.find((i) => !SUBSCRIBED.test(cell(row, i)));
		if (rejectedState !== undefined) {
			skip(cell(row, rejectedState).toLowerCase().slice(0, 40));
			continue;
		}
		const rejectedType = typeAts.find((i) => !SUBSTACK_TYPE.test(cell(row, i)));
		if (rejectedType !== undefined) {
			skip(cell(row, rejectedType).toLowerCase().slice(0, 40));
			continue;
		}
		if (disabledAts.some((i) => TRUE.test(cell(row, i)))) {
			skip("email turned off");
			continue;
		}
		if (
			(needsPreferences && emailDisabledAts.length === 0) ||
			disabledAts.some((i) => !FALSE.test(cell(row, i)))
		) {
			skip("email preference missing");
			continue;
		}
		if (digestAts.some((i) => TRUE.test(cell(row, i)))) {
			skip("digest enabled");
			continue;
		}
		if (
			(needsPreferences && digestAts.length === 0) ||
			digestAts.some((i) => !FALSE.test(cell(row, i)))
		) {
			skip("digest preference missing");
			continue;
		}
		const email = normalizeEmail(row[emailAt]);
		if (!email) {
			report.invalid++;
			continue;
		}
		if (DELETION_REQUEST.test(email)) {
			skip("asked to be deleted");
			continue;
		}
		const subscribedAt = dateAt >= 0 ? dateOf(row[dateAt] ?? "") : undefined;
		const id = await subscriberId(env, email);
		const imported: Subscriber = {
			email,
			status: "confirmed",
			createdAt: now,
			confirmedAt: now,
			consent: {
				source: "import",
				...(from ? { from } : {}),
				site,
				at: now,
				...(subscribedAt ? { subscribedAt } : {}),
			},
		};
		const made = await env.subscribers.compareAndSet(id, null, imported);
		if (made.applied) {
			report.imported++;
			continue;
		}
		const have = await env.subscribers.get(id);
		if (have?.status === "confirmed") {
			report.already++;
			continue;
		}
		// Given on this site's form and not confirmed yet: the list says they subscribed on WordPress.
		await env.subscribers.put(id, {
			...imported,
			...(have?.fragment ? { fragment: have.fragment } : {}),
		});
		await env.outbox.delete(`confirm:${id}`);
		report.confirmed++;
	}
	return report;
}
