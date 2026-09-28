/**
 * The mail broker: the one door a site's mail goes out through. It runs in a
 * Worker of its own (./worker.ts), one per site, and its Durable Object
 * (MailBroker, one per site) is the only thing that holds the site's
 * `send_email` bindings (EMAIL_PLUGIN for the site's own mail, EMAIL_SYSTEM
 * for its sign-in mail) and both of its mail-budget tokens. The site's Worker
 * holds a service binding to the broker and one opaque CAPABILITY, and nothing
 * that sends: it hands the broker a fixed envelope (or an auth operation) and
 * its capability.
 *
 * WHY. Whatever runs in the site's Worker (its plugins, and anything that gets
 * in) holds what that Worker holds. A `send_email` binding or a budget token
 * there can be called from an old isolate after the operator rotated it: a
 * take that returned before the rotation can still be followed by a send
 * after it, since the send is outside the budget's transaction. So the send
 * binding and the tokens live here, behind a queue that also decides which
 * capability counts.
 *
 * GENERATIONS. The operator (through the admin door, ./worker.ts `fetch`)
 * stages a generation G: its number, the SHA-256 of the capability it gives the
 * site's Worker for G, and G's two budget tokens, which this Durable Object
 * keeps in its own storage. Then it activates G. One generation is active at
 * a time, and a request counts only when its capability hashes to the ACTIVE
 * one's: a staged generation's capability, a retired one's, and any other are
 * refused before anything is read, written, counted or sent. The active
 * generation is in storage, so it survives an eviction, a restart and an
 * upload of this Worker.
 *
 * THE QUEUE. Every call (each send, each auth operation, each status, and
 * every admin call: stage, activate, retire, state) takes its turn in ONE
 * queue, and runs to its end before the next starts: the capability check,
 * the budget's take, the awaited `send_email` call, and the refund when the
 * binding refuses. A Durable Object alone does not give that (a request's
 * awaits let the next one in), so the queue is this module's own (`serial`).
 * An activation therefore answers only after every call queued before it
 * reached its end (sent, or refused and given back), and every call queued
 * after it is checked against the generation it activated: no delivery with
 * the old capability completes after an activation's answer. The binding's
 * send is not cut short by a timeout: a send that was still running when a
 * timeout fired could complete after the answer, so the queue waits for it.
 * Each call is numbered as it enters (`seq`, kept in storage), and its answer
 * carries the number, so the order the queue ran calls in can be read.
 *
 * WHAT A SEND IS. `send({ protocol, capability, requestId, message })`, where
 * the message is exactly `{ to, cc?, subject, text, html?, replyTo? }`: the
 * sender, its name and every other header are the broker's own configuration.
 * Each recipient is one plain address the broker's recipient list allows (the
 * addresses the operator allowed, the ones the site's forms notified before
 * the move among them); the subject is header text; a reply-to that is not one
 * plain address is dropped. The take is the plugin lane's, with the request's
 * id, so a retry of it counts once; a request id seen already answers what it
 * came to the first time and sends nothing again. Sign-in mail is the four
 * operations of ./mediator.ts, run in the same queue with the system lane's
 * token and EMAIL_SYSTEM.
 *
 * Nothing here imports `cloudflare:workers`: ./worker.ts wraps it in the
 * Durable Object and the entrypoint.
 */

import type { Kysely } from "kysely";

import {
	MAX_SUBJECT,
	displayName,
	domainOf,
	headerText,
	mailbox,
} from "../plugins/email-headers.js";
import { MAIL_BUDGET_PROTOCOL } from "../plugins/mail-budget-protocol.js";
import {
	AUTH_MAIL_MARKER,
	AUTH_MAIL_PROTOCOL,
	createAuthMailMediator,
	type AuthMailAnswer,
	type AuthMailTables,
	type SystemBudgetService,
} from "./mediator.js";

/** A capability and a budget token: 32 random bytes, base64url, as the operator mints them. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A request id: what a retry of the same send names again. */
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** How long a call to the mail budget may take, and how long a late one is waited for so it can be given back. */
const BUDGET_TIMEOUT_MS = 5_000;
const BUDGET_LATE_MS = 30_000;
/** The most recipients one message may have (the budget's most per take). */
const MAX_RECIPIENTS = 50;
/** The most a message's text and html may be, each. */
const MAX_TEXT = 256 * 1024;
const MAX_HTML = 1024 * 1024;
/** How long a request id is remembered (it is looked up on its day and the next). */
const DAY_MS = 86_400_000;
/** The operator's secret must be at least this long, or the admin door answers nothing. */
const MIN_ADMIN_SECRET = 32;
/** The fields a message may have: nothing else reaches the binding. */
const MESSAGE_FIELDS = new Set(["to", "cc", "subject", "text", "html", "replyTo"]);
/** The fields a send request may have. */
const SEND_FIELDS = new Set(["protocol", "capability", "requestId", "message"]);

/** A synchronous store: the Durable Object's SQLite in ./worker.ts, a Map in the tests. */
export interface BrokerStore {
	get(key: string): unknown;
	put(key: string, value: unknown): void;
	delete(key: string): void;
	/** Keys that start with `prefix`, in order, at most `limit`. */
	keys(prefix: string, limit: number): string[];
}

/** A `send_email` binding as the broker calls it. */
export interface BrokerSendBinding {
	send(message: {
		to: string;
		cc?: string[];
		from: { email: string; name?: string };
		subject: string;
		text: string;
		html?: string;
		replyTo?: string;
	}): Promise<unknown>;
}

/** The mail budget's service binding (mail-budget protocol 3). */
export interface BrokerBudgetService extends SystemBudgetService {
	report(request: { protocol: number; token: string }): Promise<unknown>;
}

/** What the broker's Worker is configured with: its env, read by brokerConfigFromEnv. */
export interface BrokerConfig {
	/** The site this broker is (its slug), as the operator set it. */
	tenant: string | null;
	/** What the operator says this deployment is (an opaque label the status echoes). */
	deployment: string | null;
	/** Whom a send may go to: the operator's list, lower case. */
	recipients: Set<string> | { missing: string };
	/** The site's URL, name and sender. */
	site: { url: string; name: string; from: string } | { missing: string };
	/** The operator's secret for the admin door. */
	adminSecret: string | null;
	/** EMAIL_PLUGIN and EMAIL_SYSTEM. */
	plugin: BrokerSendBinding | null;
	system: BrokerSendBinding | null;
	/** MAIL_BUDGET. */
	budget: BrokerBudgetService | null;
}

export interface BrokerDeps {
	store: BrokerStore;
	config: BrokerConfig;
	/** The site's database (auth operations), through Kysely. */
	db: Kysely<AuthMailTables> | null;
	/** The site's session store, read-only. */
	sessions: { get(key: string): Promise<string | null> } | null;
	now?: () => number;
	/** Keeps work alive past an answer (the Durable Object's waitUntil). */
	extend?: (work: Promise<unknown>) => void;
	/** A log line; never given an address, a token or a capability. */
	log?: (line: string) => void;
	/** A random request id (a take's, when the operation names none). */
	id?: () => string;
}

/** One generation as the store keeps it: never answered with its tokens. */
interface Generation {
	generation: number;
	capabilityHash: string;
	tokens: { plugin: string; system: string };
	tokenHashes: { plugin: string; system: string };
	at: string;
}

/** A generation as an answer says it: no token. */
export interface GenerationView {
	generation: number;
	capabilityHash: string;
	tokenHashes: { plugin: string; system: string };
	at: string;
}

export type BrokerAnswer =
	| { protocol: typeof AUTH_MAIL_PROTOCOL; status: "sent"; seq: number; replayed?: true }
	| {
			protocol: typeof AUTH_MAIL_PROTOCOL;
			status: "skipped" | "refused";
			why: string;
			seq: number;
			replayed?: true;
	  };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** SHA-256 of `text`, hex. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `call`'s answer, or `late` when it has not answered within `ms`. */
async function within<T>(call: Promise<T>, ms: number): Promise<{ answer: T } | { late: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<{ late: true }>((resolve) => {
		timer = setTimeout(resolve, ms, { late: true });
	});
	try {
		return await Promise.race([call.then((a) => ({ answer: a })), late]);
	} finally {
		clearTimeout(timer);
	}
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const refused = (why: string, seq: number): BrokerAnswer => ({
	protocol: AUTH_MAIL_PROTOCOL,
	status: "refused",
	why,
	seq,
});

function asGeneration(v: unknown): Generation | null {
	if (!isRecord(v) || !Number.isSafeInteger(v.generation) || typeof v.capabilityHash !== "string")
		return null;
	const tokens = v.tokens;
	const hashes = v.tokenHashes;
	if (!isRecord(tokens) || !isRecord(hashes)) return null;
	if (typeof tokens.plugin !== "string" || typeof tokens.system !== "string") return null;
	if (typeof hashes.plugin !== "string" || typeof hashes.system !== "string") return null;
	return {
		generation: Number(v.generation),
		capabilityHash: v.capabilityHash,
		tokens: { plugin: tokens.plugin, system: tokens.system },
		tokenHashes: { plugin: hashes.plugin, system: hashes.system },
		at: typeof v.at === "string" ? v.at : "",
	};
}

const view = (g: Generation | null): GenerationView | null =>
	g
		? {
				generation: g.generation,
				capabilityHash: g.capabilityHash,
				tokenHashes: { ...g.tokenHashes },
				at: g.at,
			}
		: null;

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});

/** Whether `given` is the secret: both hashed, then compared in time that does not depend on where they differ. */
async function sameSecret(given: string, secret: string): Promise<boolean> {
	const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(secret)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0 && a.length === b.length;
}

/**
 * The answer to an admin request that does not carry the operator's secret
 * (`secret`, BROKER_ADMIN_SECRET), or null when it does: 503 when the broker
 * has no secret of at least 32 characters, 401 for any other bearer. The
 * entrypoint (./worker.ts) asks this before it hands a request to the Durable
 * Object, and the object asks it again.
 */
export async function adminRefusal(request: Request, secret: unknown): Promise<Response | null> {
	if (typeof secret !== "string" || secret.length < MIN_ADMIN_SECRET) {
		return json(503, {
			ok: false,
			error:
				"the broker has no operator secret (BROKER_ADMIN_SECRET), so it answers no admin request",
		});
	}
	const auth = request.headers.get("authorization") ?? "";
	if (!auth.startsWith("Bearer ") || !(await sameSecret(auth.slice(7), secret))) {
		return json(401, { ok: false, error: "not the operator" });
	}
	return null;
}

/**
 * The broker over its store and configuration. Every method answers what it
 * came to and never throws for a request, a refusal or a failed send.
 */
export function createMailBroker(deps: BrokerDeps) {
	const { store, config } = deps;
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});
	const extend = deps.extend ?? ((work: Promise<unknown>) => void work.catch(() => undefined));
	const newId = deps.id ?? (() => crypto.randomUUID());

	// THE QUEUE: each call starts only once every call before it has ended.
	let tail: Promise<unknown> = Promise.resolve();
	/** Run `work` in its turn, numbered as it enters. */
	function serial<T>(work: (seq: number) => Promise<T>): Promise<T> {
		const seq = Number(store.get("seq") ?? 0) + 1;
		store.put("seq", seq);
		const run = tail.then(
			() => work(seq),
			() => work(seq),
		);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	const active = () => asGeneration(store.get("active"));
	const staged = () => asGeneration(store.get("staged"));
	const highest = () => Number(store.get("highest") ?? 0);

	/**
	 * The active generation, when `capability` is its capability; otherwise why
	 * not. Read at the call's turn in the queue, before anything else it does.
	 */
	async function admit(capability: unknown): Promise<{ gen: Generation } | { why: string }> {
		if (typeof capability !== "string" || !SECRET.test(capability))
			return { why: "the request carries no capability" };
		const hash = await sha256Hex(capability);
		const a = active();
		if (a && a.capabilityHash === hash) return { gen: a };
		const s = staged();
		if (s && s.capabilityHash === hash)
			return {
				why: `the capability is generation ${s.generation}'s, which is staged, not active: it sends nothing until the operator activates it`,
			};
		return {
			why: "the capability is not this site's active generation's (it is stale, retired or unknown)",
		};
	}

	/** Remember what a request id came to (on its day), and forget ids two days old. */
	function remember(requestId: string, answer: BrokerAnswer) {
		const day = dayOf(now());
		store.put(`op:${day}:${requestId}`, answer);
		const cut = `op:${dayOf(now() - DAY_MS)}`;
		for (const key of store.keys("op:", 50)) {
			if (key >= cut) break;
			store.delete(key);
		}
	}

	function recalled(requestId: string): BrokerAnswer | null {
		for (const day of [dayOf(now()), dayOf(now() - DAY_MS)]) {
			const seen = store.get(`op:${day}:${requestId}`);
			if (isRecord(seen) && typeof seen.status === "string") {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- written by remember() above
				return seen as unknown as BrokerAnswer;
			}
		}
		return null;
	}

	/**
	 * Take `recipients` (hashes) from the budget with `token`, for `requestId`:
	 * the take, or why not. A take that answers too late is waited for a while
	 * more and given back, so the call ends with nothing counted.
	 */
	async function take(
		token: string,
		recipients: string[],
		requestId: string,
		want: { lane: "plugin" | "system"; generation: number },
	): Promise<{ takeId: string } | { why: string }> {
		const budget = config.budget;
		if (!budget) return { why: "the broker has no service binding MAIL_BUDGET" };
		const ask = () => budget.take({ protocol: MAIL_BUDGET_PROTOCOL, token, recipients, requestId });
		let call = ask();
		let got: { answer: unknown } | { late: true };
		try {
			got = await within(call, BUDGET_TIMEOUT_MS);
		} catch {
			// The answer was lost (the call threw): the same request id again is the same take.
			try {
				call = ask();
				got = await within(call, BUDGET_TIMEOUT_MS);
			} catch {
				return { why: "the mail budget could not be asked" };
			}
		}
		if ("late" in got) {
			const settled = await within(
				call.catch(() => null),
				BUDGET_LATE_MS,
			);
			const late = "late" in settled ? null : settled.answer;
			if (isRecord(late) && late.ok === true && typeof late.takeId === "string") {
				await giveBack(token, late.takeId);
			} else if ("late" in settled) {
				extend(
					call
						.then((a) =>
							isRecord(a) && a.ok === true && typeof a.takeId === "string"
								? giveBack(token, a.takeId)
								: undefined,
						)
						.catch(() => undefined),
				);
			}
			return { why: "the mail budget did not answer in time" };
		}
		const a = got.answer;
		const takeId = isRecord(a) && a.ok === true && typeof a.takeId === "string" ? a.takeId : null;
		if (!isRecord(a) || a.protocol !== MAIL_BUDGET_PROTOCOL) {
			if (takeId) await giveBack(token, takeId);
			return { why: "the mail budget answered in another protocol" };
		}
		if (!takeId) {
			return {
				why: `the mail budget refused it${typeof a.scope === "string" ? ` (${a.scope})` : ""}`,
			};
		}
		if (a.lane !== want.lane || a.generation !== want.generation) {
			await giveBack(token, takeId);
			return {
				why: `the mail budget counted it to the ${JSON.stringify(a.lane ?? null)} lane of generation ${JSON.stringify(a.generation ?? null)}, not the ${want.lane} lane of ${want.generation}`,
			};
		}
		return { takeId };
	}

	/** Give a take back with the token that made it: awaited within the timeout, and kept alive past it. */
	async function giveBack(token: string, takeId: string): Promise<void> {
		const budget = config.budget;
		if (!budget) return;
		try {
			const refund = budget.refund({ protocol: MAIL_BUDGET_PROTOCOL, token, takeId });
			if ("late" in (await within(refund, BUDGET_TIMEOUT_MS)))
				extend(refund.catch(() => undefined));
		} catch {
			log("mail broker: the mail budget did not take a refund back");
		}
	}

	/** The message as the binding gets it, or why not: exactly the envelope's fields, each checked. */
	function envelope(
		message: unknown,
		site: { name: string; from: string },
		allowed: Set<string>,
	):
		| {
				out: Parameters<BrokerSendBinding["send"]>[0];
				recipients: string[];
		  }
		| { why: string } {
		if (!isRecord(message)) return { why: "the message is not an object" };
		const extra = Object.keys(message).filter((k) => !MESSAGE_FIELDS.has(k));
		if (extra.length) {
			return {
				why: `a message takes no ${extra.map((k) => JSON.stringify(k)).join(", ")}: its sender and headers are the broker's`,
			};
		}
		const to = mailbox(message.to);
		if (!to || to !== message.to) return { why: "its to is not one plain address" };
		const ccIn = message.cc ?? [];
		if (!Array.isArray(ccIn)) return { why: "its cc is not a list" };
		const cc: string[] = [];
		for (const c of ccIn) {
			const a = mailbox(c);
			if (!a || a !== c) return { why: "a cc is not one plain address" };
			cc.push(a);
		}
		const recipients = [to, ...cc];
		if (recipients.length > MAX_RECIPIENTS)
			return { why: `a message goes to at most ${MAX_RECIPIENTS} recipients` };
		const outside = recipients.filter((r) => !allowed.has(r.toLowerCase()));
		if (outside.length) {
			return {
				why: `${outside.length} of its recipients (at ${[...new Set(outside.map(domainOf))].join(", ")}) are not on the broker's recipient list`,
			};
		}
		const subject = headerText(message.subject, MAX_SUBJECT);
		if (!subject) return { why: "its subject is empty once its control characters are removed" };
		if (typeof message.text !== "string" || message.text.length > MAX_TEXT)
			return { why: `its text is not a string of at most ${MAX_TEXT} characters` };
		if (
			message.html !== undefined &&
			(typeof message.html !== "string" || message.html.length > MAX_HTML)
		)
			return { why: `its html is not a string of at most ${MAX_HTML} characters` };
		const replyTo = message.replyTo === undefined ? null : mailbox(message.replyTo);
		if (message.replyTo !== undefined && !replyTo)
			log("mail broker: a reply-to that is not one plain address was dropped");
		const name = displayName(site.name);
		return {
			recipients,
			out: {
				from: name ? { email: site.from, name } : { email: site.from },
				to,
				subject,
				text: message.text,
				...(typeof message.html === "string" && message.html ? { html: message.html } : {}),
				...(cc.length ? { cc } : {}),
				...(replyTo ? { replyTo } : {}),
			},
		};
	}

	/** One send of the site's own mail, in its turn: capability, envelope, the plugin lane's take, EMAIL_PLUGIN, the give-back. */
	function send(request: unknown): Promise<BrokerAnswer> {
		return serial(async (seq) => {
			const r = isRecord(request) ? request : {};
			if (r.protocol !== AUTH_MAIL_PROTOCOL)
				return refused(
					`the broker speaks protocol ${AUTH_MAIL_PROTOCOL}, and the request names ${JSON.stringify(r.protocol ?? null)}`,
					seq,
				);
			const got = await admit(r.capability);
			if ("why" in got) return refused(got.why, seq);
			const extra = Object.keys(r).filter((k) => !SEND_FIELDS.has(k));
			if (extra.length)
				return refused(`a send takes no ${extra.map((k) => JSON.stringify(k)).join(", ")}`, seq);
			const requestId = r.requestId;
			if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
				return refused("a send names its request id (16 to 64 letters, digits, - or _)", seq);
			const seen = recalled(requestId);
			if (seen) return { ...seen, replayed: true };
			if ("missing" in config.site) return refused(config.site.missing, seq);
			if ("missing" in config.recipients) return refused(config.recipients.missing, seq);
			if (!config.plugin) return refused("the broker has no EMAIL_PLUGIN binding", seq);
			const env = envelope(r.message, config.site, config.recipients);
			if ("why" in env) return refused(env.why, seq);
			const hashes = await Promise.all(env.recipients.map((a) => sha256Hex(a.toLowerCase())));
			const token = got.gen.tokens.plugin;
			const t = await take(token, hashes, requestId, {
				lane: "plugin",
				generation: got.gen.generation,
			});
			if ("why" in t) {
				const a = refused(t.why, seq);
				remember(requestId, a);
				return a;
			}
			// Written before the send: a retry of a send that never finished (the object
			// restarted inside it) is not known to be unsent, so it is not sent again.
			remember(
				requestId,
				refused(
					"an earlier attempt with this request id did not finish: whether it was sent is not known, so it is not sent again",
					seq,
				),
			);
			try {
				await config.plugin.send(env.out);
			} catch (error) {
				await giveBack(token, t.takeId);
				const code =
					isRecord(error) && typeof error.code === "string"
						? error.code
						: error instanceof Error
							? error.name
							: "error";
				const a = refused(`EMAIL_PLUGIN refused it (${code})`, seq);
				remember(requestId, a);
				return a;
			}
			const a: BrokerAnswer = { protocol: AUTH_MAIL_PROTOCOL, status: "sent", seq };
			remember(requestId, a);
			return a;
		});
	}

	type Operation = "requestMagicLink" | "requestSignup" | "createInvite" | "sendRecovery";

	/** One auth operation, in its turn: capability first, then ./mediator.ts with the system lane's token and EMAIL_SYSTEM. */
	function operate(op: Operation, request: unknown): Promise<BrokerAnswer> {
		return serial(async (seq) => {
			const r = isRecord(request) ? request : {};
			if (r.protocol !== AUTH_MAIL_PROTOCOL)
				return refused(
					`the broker speaks protocol ${AUTH_MAIL_PROTOCOL}, and the request names ${JSON.stringify(r.protocol ?? null)}`,
					seq,
				);
			const got = await admit(r.capability);
			if ("why" in got) return refused(got.why, seq);
			if (!deps.db) return refused("the broker has no DB binding", seq);
			const { capability: _capability, ...rest } = r;
			const gen = got.gen;
			const budget = config.budget;
			const mediator = createAuthMailMediator({
				db: deps.db,
				sessions: deps.sessions,
				budget: budget
					? {
							service: {
								// The system lane of THIS generation, or it is not this broker's take (the mediator gives it back).
								take: (req) =>
									budget
										.take(req)
										.then((a) =>
											isRecord(a) && a.ok === true && a.generation !== gen.generation
												? { ...a, lane: "another generation's" }
												: a,
										),
								refund: (req) => budget.refund(req),
							},
							token: gen.tokens.system,
						}
					: { missing: "the broker has no service binding MAIL_BUDGET" },
				send: config.system,
				site: config.site,
				now,
				extend,
				log,
				id: newId,
			});
			const a: AuthMailAnswer = await mediator[op](rest);
			return { ...a, seq };
		});
	}

	/** A lane's budget report for a generation's token, read strictly. */
	async function reportOf(token: string) {
		const budget = config.budget;
		if (!budget)
			return { ok: false as const, why: "the broker has no service binding MAIL_BUDGET" };
		try {
			const got = await within(
				budget.report({ protocol: MAIL_BUDGET_PROTOCOL, token }),
				BUDGET_TIMEOUT_MS,
			);
			if ("late" in got) return { ok: false as const, why: "no answer in time" };
			const r = got.answer;
			if (!isRecord(r) || r.protocol !== MAIL_BUDGET_PROTOCOL)
				return { ok: false as const, why: "answered in another protocol" };
			if (r.ok !== true)
				return {
					ok: false as const,
					why: `refused${typeof r.scope === "string" ? ` (${r.scope})` : ""}`,
				};
			return {
				ok: true as const,
				tenant: r.tenant,
				lane: r.lane,
				generation: r.generation,
				state: r.state,
				caps: isRecord(r.caps) ? r.caps : null,
			};
		} catch {
			return { ok: false as const, why: "could not be asked" };
		}
	}

	/** Why a generation's tokens are not this site's `state` lanes of that generation in the budget, or null. */
	async function lanesRefused(
		gen: Pick<Generation, "generation" | "tokens">,
		states: readonly string[],
	): Promise<string | null> {
		for (const lane of ["plugin", "system"] as const) {
			const r = await reportOf(gen.tokens[lane]);
			if (!r.ok) return `the mail budget does not report the ${lane} token (${r.why})`;
			if (r.tenant !== config.tenant)
				return `the mail budget holds the ${lane} token for ${JSON.stringify(r.tenant ?? null)}, not this broker's site`;
			if (r.lane !== lane)
				return `the mail budget holds the ${lane} token in the ${JSON.stringify(r.lane ?? null)} lane`;
			if (r.generation !== gen.generation)
				return `the mail budget holds the ${lane} token for generation ${JSON.stringify(r.generation ?? null)}, not ${gen.generation}`;
			if (typeof r.state !== "string" || !states.includes(r.state))
				return `the mail budget holds the ${lane} token ${JSON.stringify(r.state ?? null)}, not ${states.join(" or ")}`;
		}
		return null;
	}

	/**
	 * What the broker is, for the generation `capability` names: its marker and
	 * protocol, the site and deployment it is configured as, the active and
	 * staged generations' numbers, and, for a capability that is the active or
	 * the staged one's, that generation's capability hash, token hashes and the
	 * budget's report of each lane. Sends, counts and writes nothing; a
	 * capability that is neither is told the numbers only, and nothing is asked.
	 */
	function status(request: unknown) {
		return serial(async (seq) => {
			const r = isRecord(request) ? request : {};
			if (r.protocol !== AUTH_MAIL_PROTOCOL)
				return refused(`the broker speaks protocol ${AUTH_MAIL_PROTOCOL}`, seq);
			const a = active();
			const s = staged();
			const hash =
				typeof r.capability === "string" && SECRET.test(r.capability)
					? await sha256Hex(r.capability)
					: null;
			const which =
				hash && a?.capabilityHash === hash
					? "active"
					: hash && s?.capabilityHash === hash
						? "staged"
						: "unknown";
			const base = {
				protocol: AUTH_MAIL_PROTOCOL,
				marker: AUTH_MAIL_MARKER,
				seq,
				tenant: config.tenant,
				deployment: config.deployment,
				send: { plugin: config.plugin !== null, system: config.system !== null },
				site: !("missing" in config.site),
				recipients: "missing" in config.recipients ? null : config.recipients.size,
				generations: { active: a?.generation ?? null, staged: s?.generation ?? null },
				capability: which,
			};
			const gen = which === "active" ? a : which === "staged" ? s : null;
			if (!gen) return base;
			return {
				...base,
				generation: gen.generation,
				capabilityHash: gen.capabilityHash,
				tokenHashes: { ...gen.tokenHashes },
				budget: {
					plugin: await reportOf(gen.tokens.plugin),
					system: await reportOf(gen.tokens.system),
				},
			};
		});
	}

	/** The broker's state as the admin door answers it: numbers and hashes, never a token. */
	const state = (seq: number) => ({
		ok: true,
		seq,
		tenant: config.tenant,
		deployment: config.deployment,
		active: view(active()),
		staged: view(staged()),
		highest: highest(),
	});

	const conflict = (why: string, seq: number) =>
		json(409, { ...state(seq), ok: false, conflict: true, why });

	/**
	 * The operator's door, behind BROKER_ADMIN_SECRET:
	 *   GET  /admin/state      the active and staged generations (numbers and hashes), the highest ever staged, `seq`
	 *   POST /admin/stage      { generation, capabilityHash, tokens: { plugin, system }, expectActive }
	 *                          stage a generation after every one before it, while `expectActive` is the active
	 *                          one's number (null for none); its tokens must be this site's, that generation's,
	 *                          STAGED lanes in the budget. Replaces any other staged one.
	 *   POST /admin/activate   { generation, capabilityHash, expectActive }: the staged one active, in its turn
	 *                          (after every call before it ended), while `expectActive` is the active one's number
	 *   POST /admin/retire     { generation }: that generation, active or staged, no longer counts
	 * Each is answered after its turn in the queue, with the state it left.
	 */
	async function admin(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/admin/"))
			return json(404, { ok: false, error: `${AUTH_MAIL_MARKER}: not found` });
		const refusal = await adminRefusal(request, config.adminSecret);
		if (refusal) return refusal;
		const verb = url.pathname.slice("/admin/".length);
		if (verb === "state") {
			if (request.method !== "GET") return json(405, { ok: false, error: "GET" });
			return serial(async (seq) => json(200, state(seq)));
		}
		if (!["stage", "activate", "retire"].includes(verb))
			return json(404, { ok: false, error: "not found" });
		if (request.method !== "POST") return json(405, { ok: false, error: "POST" });
		let body: unknown;
		try {
			const text = await request.text();
			if (text.length > 4096) return json(400, { ok: false, error: "the body is too large" });
			body = JSON.parse(text);
		} catch {
			return json(400, { ok: false, error: "the body is not JSON" });
		}
		const b = isRecord(body) ? body : {};
		const generation = b.generation;
		if (!Number.isSafeInteger(generation) || Number(generation) < 1)
			return json(400, { ok: false, error: "generation must be a whole number from 1" });
		const g = Number(generation);
		const expectActive = b.expectActive;
		if (verb !== "retire" && !(expectActive === null || Number.isSafeInteger(expectActive))) {
			return json(400, {
				ok: false,
				error:
					"expectActive must be the active generation's number the operator read, or null for none",
			});
		}
		if (verb === "stage") {
			const tokens = isRecord(b.tokens) ? b.tokens : {};
			const plugin = tokens.plugin;
			const system = tokens.system;
			if (
				typeof plugin !== "string" ||
				!SECRET.test(plugin) ||
				typeof system !== "string" ||
				!SECRET.test(system) ||
				plugin === system
			) {
				return json(400, {
					ok: false,
					error:
						"tokens must be the generation's two mail-budget tokens, each 43 base64url characters, never one in both lanes",
				});
			}
			if (typeof b.capabilityHash !== "string" || !HEX64.test(b.capabilityHash)) {
				return json(400, {
					ok: false,
					error:
						"capabilityHash must be the SHA-256 of the generation's capability, 64 lower-case hex characters",
				});
			}
			const capabilityHash = b.capabilityHash;
			return serial(async (seq) => {
				if ((active()?.generation ?? null) !== expectActive)
					return conflict(
						`the active generation is ${active()?.generation ?? "none"}, not ${JSON.stringify(expectActive)}`,
						seq,
					);
				if (g <= highest())
					return conflict(
						`generation ${g} is not after ${highest()}: a generation is staged once`,
						seq,
					);
				// The tokens must be this site's, that generation's, staged lanes: a token of another site, lane or generation never becomes one this broker sends with.
				const why = await lanesRefused({ generation: g, tokens: { plugin, system } }, ["staged"]);
				if (why) return json(400, { ...state(seq), ok: false, error: why });
				store.put("staged", {
					generation: g,
					capabilityHash,
					tokens: { plugin, system },
					tokenHashes: { plugin: await sha256Hex(plugin), system: await sha256Hex(system) },
					at: new Date(now()).toISOString(),
				});
				store.put("highest", g);
				return json(200, state(seq));
			});
		}
		if (verb === "activate") {
			const capabilityHash = b.capabilityHash;
			return serial(async (seq) => {
				const a = active();
				if (a && a.generation === g && a.capabilityHash === capabilityHash)
					return json(200, { ...state(seq), unchanged: true });
				const s = staged();
				if (!s || s.generation !== g || s.capabilityHash !== capabilityHash)
					return conflict(
						`the staged generation is ${s?.generation ?? "none"}, not ${g} with that capability`,
						seq,
					);
				if ((a?.generation ?? null) !== expectActive)
					return conflict(
						`the active generation is ${a?.generation ?? "none"}, not ${JSON.stringify(expectActive)}`,
						seq,
					);
				const why = await lanesRefused(s, ["staged", "active"]);
				if (why) return json(400, { ...state(seq), ok: false, error: why });
				store.put("active", { ...s, at: new Date(now()).toISOString() });
				store.delete("staged");
				log(`mail broker: generation ${g} is active (seq ${seq})`);
				return json(200, { ...state(seq), unchanged: false });
			});
		}
		return serial(async (seq) => {
			const a = active();
			const s = staged();
			const retired = [a?.generation === g && "active", s?.generation === g && "staged"].filter(
				(x): x is string => Boolean(x),
			);
			if (a?.generation === g) store.delete("active");
			if (s?.generation === g) store.delete("staged");
			return json(200, { ...state(seq), retired });
		});
	}

	return {
		send,
		requestMagicLink: (request: unknown) => operate("requestMagicLink", request),
		requestSignup: (request: unknown) => operate("requestSignup", request),
		createInvite: (request: unknown) => operate("createInvite", request),
		sendRecovery: (request: unknown) => operate("sendRecovery", request),
		status,
		admin,
	};
}

export type MailBroker = ReturnType<typeof createMailBroker>;

/** Whether `v` has each of `methods` as a function. */
const callable = (v: unknown, ...methods: string[]) =>
	isRecord(v) && methods.every((m) => typeof Reflect.get(v, m) === "function");
/** `v` trimmed, when it is a string with something in it; else null. */
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The broker's configuration from its Worker's env: BROKER_TENANT,
 * BROKER_DEPLOYMENT, BROKER_RECIPIENTS (a JSON list of addresses),
 * AUTH_MAIL_SITE_URL, AUTH_MAIL_SITE_NAME and AUTH_MAIL_FROM,
 * BROKER_ADMIN_SECRET, EMAIL_PLUGIN, EMAIL_SYSTEM and MAIL_BUDGET.
 */
export function brokerConfigFromEnv(env: Record<string, unknown>): BrokerConfig {
	let recipients: BrokerConfig["recipients"] = {
		missing: "the broker's BROKER_RECIPIENTS is not a JSON list of plain addresses",
	};
	try {
		const list: unknown =
			typeof env.BROKER_RECIPIENTS === "string" ? JSON.parse(env.BROKER_RECIPIENTS) : null;
		if (
			Array.isArray(list) &&
			list.length &&
			list.every((a) => typeof a === "string" && mailbox(a) === a)
		) {
			recipients = new Set(list.map((a: string) => a.toLowerCase()));
		}
	} catch {
		// Not JSON: missing, as above.
	}
	const from = mailbox(env.AUTH_MAIL_FROM);
	const name = text(env.AUTH_MAIL_SITE_NAME);
	let url: URL | null = null;
	try {
		url = typeof env.AUTH_MAIL_SITE_URL === "string" ? new URL(env.AUTH_MAIL_SITE_URL) : null;
	} catch {
		url = null;
	}
	return {
		tenant: text(env.BROKER_TENANT),
		deployment: text(env.BROKER_DEPLOYMENT),
		recipients,
		site:
			url && url.protocol === "https:" && name && from
				? { url: url.origin, name, from }
				: {
						missing:
							"the broker's AUTH_MAIL_SITE_URL (an https URL), AUTH_MAIL_SITE_NAME and AUTH_MAIL_FROM (one address) are not all set",
					},
		adminSecret: typeof env.BROKER_ADMIN_SECRET === "string" ? env.BROKER_ADMIN_SECRET : null,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- checked: send is callable
		plugin: callable(env.EMAIL_PLUGIN, "send") ? (env.EMAIL_PLUGIN as BrokerSendBinding) : null,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- checked: send is callable
		system: callable(env.EMAIL_SYSTEM, "send") ? (env.EMAIL_SYSTEM as BrokerSendBinding) : null,
		budget: callable(env.MAIL_BUDGET, "take", "refund", "report")
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- checked: take, refund and report are callable
				(env.MAIL_BUDGET as BrokerBudgetService)
			: null,
	};
}
