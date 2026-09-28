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
 * refused before anything is written, counted or sent (the one thing read
 * first is what a request id that capability used came to, below). The active
 * generation is in storage, so it survives an eviction, a restart and an
 * upload of this Worker.
 *
 * THE QUEUE. Every call (each send, each auth operation, each status, and
 * every admin call: stage, activate, retire, state) takes its turn in ONE
 * queue, and runs to its end before the next starts (among the calls
 * waiting, the operator's go first, then the site's, then at most
 * ANONYMOUS_WAITING_MAX anonymous sign-in requests): the capability check,
 * the budget's take, the awaited `send_email` call, and the give-back when the
 * binding refuses. A Durable Object alone does not give that (a request's
 * awaits let the next one in), so the queue is this module's own (`serial`).
 * A give-back is OWED in the object's storage before the budget is asked for
 * it, and forgotten only once the budget answers it (createBudgetClient); an
 * activation and a retire each ask for every give-back still owed, and answer
 * (acknowledge) only once none is, so the fence covers the give-backs of the
 * sends before it too, across a restart.
 * An activation therefore answers only after the call running when it came
 * reached its end (sent, or refused and given back), and every call that runs
 * after it (one it overtook among those waiting included) is checked against
 * the generation it activated: no delivery with the old capability completes
 * after an activation's answer. The binding's
 * send is not cut short by a timeout: a send that was still running when a
 * timeout fired could complete after the answer, so the queue waits for it.
 * Each call is numbered as it starts (`seq`, kept in storage), and its answer
 * carries the number, so the order the queue ran calls in can be read.
 *
 * WHAT A SEND IS. `send({ protocol, capability, requestId, message })`, where
 * the message is exactly `{ to, cc?, subject, text, html?, replyTo? }`: the
 * sender, its name and every other header are the broker's own configuration.
 * Each recipient is one plain address the broker's recipient list allows (the
 * addresses the operator allowed, the ones the site's forms notified before
 * the move among them); the subject is header text; a reply-to that is not one
 * plain address is dropped. The take is the plugin lane's, with the request's
 * id, so a retry of it counts once; a request id this capability used already
 * answers what it came to the first time and sends nothing again (`unknown`
 * when that first attempt never finished, since it may have gone), whichever
 * generation is active by then: only new work is held to the active one. A
 * request id another capability used answers nothing. Sign-in mail is the four
 * operations of ./mediator.ts, run in the same queue with the system lane and
 * EMAIL_SYSTEM; each names a request id too, and is remembered the same way:
 * `unknown` from just before EMAIL_SYSTEM is asked to send, then what it came
 * to.
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
	type SystemLane,
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
/** How many owed give-backs one fence (an activation or a retire) asks the budget for before it answers. */
const REFUNDS_PER_FENCE = 100;
/** How many anonymous sign-in requests (magic link, sign-up) may wait in the queue; one more is refused at once. */
export const ANONYMOUS_WAITING_MAX = 16;

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

/**
 * The mail budget's service binding (mail-budget protocol 3). A refund names
 * the take it gives back, or, when the take's answer never came, the request
 * id the take was asked with: the budget gives back the take that request id
 * made with that token, or answers that it holds none.
 */
export interface BrokerBudgetService {
	take(request: {
		protocol: number;
		token: string;
		recipients: string[];
		requestId: string;
	}): Promise<unknown>;
	refund(
		request:
			| { protocol: number; token: string; takeId: string }
			| { protocol: number; token: string; requestId: string },
	): Promise<unknown>;
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
	/** A log line; never given an address, a token or a capability. */
	log?: (line: string) => void;
	/** A random request id (a sign-in message's take's). */
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

/**
 * What a call came to. `refused` and `skipped` say nothing was sent. `unknown`
 * is a send whose first attempt did not finish (the object stopped inside it):
 * it may have gone, so it is neither sent again nor said to be unsent.
 */
export type BrokerAnswer =
	| { protocol: typeof AUTH_MAIL_PROTOCOL; status: "sent"; seq: number; replayed?: true }
	| {
			protocol: typeof AUTH_MAIL_PROTOCOL;
			status: "skipped" | "refused" | "unknown";
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

/**
 * What a request id is remembered as while its message is inside the Email
 * binding's send: a retry of it, after the object stopped there, is neither
 * sent again nor said to be unsent.
 */
const unfinished = (seq: number): BrokerAnswer => ({
	protocol: AUTH_MAIL_PROTOCOL,
	status: "unknown",
	why: "an earlier attempt with this request id did not finish: whether it was sent is not known, so it is not sent again",
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
 * A give-back the broker owes the budget, kept in its storage until the
 * budget answers it: the token that took, the request id it took with, and
 * the take's id when its answer came.
 */
interface OwedRefund {
	token: string;
	requestId: string;
	takeId: string | null;
	at: string;
}

function asOwed(v: unknown): OwedRefund | null {
	if (!isRecord(v) || typeof v.token !== "string" || typeof v.requestId !== "string") return null;
	return {
		token: v.token,
		requestId: v.requestId,
		takeId: typeof v.takeId === "string" ? v.takeId : null,
		at: typeof v.at === "string" ? v.at : "",
	};
}

const owedKey = (requestId: string) => `refund:${requestId}`;

/**
 * The mail budget as the broker asks it, for both lanes: a take, and every
 * give-back OWED in the broker's storage before the budget is asked for it,
 * and forgotten only once the budget answers it. Nothing is handed to work
 * that outlives a call: a give-back the budget does not answer stays owed, and
 * the next fence (an activation or a retire) asks for it again before it
 * answers, across a restart too.
 */
export function createBudgetClient(deps: {
	store: BrokerStore;
	budget: BrokerBudgetService | null;
	now?: () => number;
	log?: (line: string) => void;
	id?: () => string;
}) {
	const { store, budget } = deps;
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});
	const newId = deps.id ?? (() => crypto.randomUUID());
	const owe = (token: string, requestId: string, takeId: string | null) =>
		store.put(owedKey(requestId), { token, requestId, takeId, at: new Date(now()).toISOString() });

	/**
	 * Ask the budget for one give-back the broker owes, once, within the
	 * timeout. It is settled (and forgotten) when the budget gives it back, or
	 * answers that it already did, or that it holds no such take (a take that
	 * never committed): each of those answers is the same every time it is
	 * asked. Anything else (no answer in time, a lost answer, another protocol)
	 * keeps it owed. True when settled.
	 */
	async function settle(key: string): Promise<boolean> {
		const owed = asOwed(store.get(key));
		if (!owed) {
			store.delete(key);
			return true;
		}
		if (!budget) return false;
		try {
			const request = owed.takeId
				? { protocol: MAIL_BUDGET_PROTOCOL, token: owed.token, takeId: owed.takeId }
				: { protocol: MAIL_BUDGET_PROTOCOL, token: owed.token, requestId: owed.requestId };
			const got = await within(budget.refund(request), BUDGET_TIMEOUT_MS);
			if ("late" in got) return false;
			const a = got.answer;
			if (!isRecord(a) || a.protocol !== MAIL_BUDGET_PROTOCOL) return false;
			if (a.ok !== true && !["take", "request", "token"].includes(String(a.scope))) return false;
			store.delete(key);
			return true;
		} catch {
			return false;
		}
	}

	/** Give back what `token` took for `requestId` (its `takeId`, or null when the take's answer never came): owed first, then asked once. */
	async function giveBack(token: string, requestId: string, takeId: string | null): Promise<void> {
		owe(token, requestId, takeId);
		if (!(await settle(owedKey(requestId))))
			log(
				"mail broker: a give-back to the mail budget is owed, and is asked for again at the next fence",
			);
	}

	/** How many give-backs are owed (counted up to one more than a fence asks for). */
	const owed = () => store.keys("refund:", REFUNDS_PER_FENCE + 1).length;

	const client = {
		giveBack,
		owed,
		/** Every owed give-back asked for again, up to REFUNDS_PER_FENCE: how many are still owed after. */
		async settleOwed(): Promise<number> {
			for (const key of store.keys("refund:", REFUNDS_PER_FENCE)) await settle(key);
			return owed();
		},

		/**
		 * Take `recipients` (hashes) with `token`, for `requestId`: the take, or
		 * why not. A take whose answer does not come in time is owed back BEFORE
		 * it is waited for any more, so whatever it counted is given back, now
		 * or at the next fence; one whose answer is lost is asked again with the
		 * same request id (the same take), and owed back if that is lost too.
		 */
		async take(
			token: string,
			recipients: string[],
			requestId: string,
			want: { lane: "plugin" | "system"; generation: number },
		): Promise<{ takeId: string } | { why: string }> {
			if (!budget) return { why: "the broker has no service binding MAIL_BUDGET" };
			const ask = () =>
				budget.take({ protocol: MAIL_BUDGET_PROTOCOL, token, recipients, requestId });
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
					// Either call may have counted: whatever this request id took is owed back.
					await giveBack(token, requestId, null);
					return { why: "the mail budget could not be asked" };
				}
			}
			if ("late" in got) {
				owe(token, requestId, null);
				const settled = await within(
					call.catch(() => null),
					BUDGET_LATE_MS,
				);
				const late = "late" in settled ? null : settled.answer;
				if (isRecord(late) && late.ok === true && typeof late.takeId === "string") {
					await giveBack(token, requestId, late.takeId);
				} else if (isRecord(late) && late.ok !== true && late.protocol === MAIL_BUDGET_PROTOCOL) {
					// The budget refused it: nothing was counted, nothing is owed.
					store.delete(owedKey(requestId));
				}
				return { why: "the mail budget did not answer in time" };
			}
			const a = got.answer;
			const takeId = isRecord(a) && a.ok === true && typeof a.takeId === "string" ? a.takeId : null;
			if (!isRecord(a) || a.protocol !== MAIL_BUDGET_PROTOCOL) {
				if (takeId) await giveBack(token, requestId, takeId);
				return { why: "the mail budget answered in another protocol" };
			}
			if (!takeId) {
				return {
					why: `the mail budget refused it${typeof a.scope === "string" ? ` (${a.scope})` : ""}`,
				};
			}
			// A replayed take the budget gave back already is no place to send in, whatever else it says.
			if (a.refunded === true) return { why: "the mail budget refused it (refunded)" };
			if (a.lane !== want.lane || a.generation !== want.generation) {
				await giveBack(token, requestId, takeId);
				return {
					why: `the mail budget counted it to the ${JSON.stringify(a.lane ?? null)} lane of generation ${JSON.stringify(a.generation ?? null)}, not the ${want.lane} lane of ${want.generation}`,
				};
			}
			return { takeId };
		},

		/** One generation's lane as the mediator takes from it: one message's place per take, a fresh request id each. */
		lane(token: string, want: { lane: "plugin" | "system"; generation: number }): SystemLane {
			return {
				take: async (recipient) => {
					const requestId = newId();
					const t = await client.take(token, [recipient], requestId, want);
					return "why" in t ? t : { takeId: t.takeId, requestId };
				},
				giveBack: (t) => giveBack(token, t.requestId, t.takeId),
			};
		},
	};
	return client;
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
 * Who a call is, for its place among the calls waiting in the queue: the
 * operator's admin calls, the site's own calls (its sends, an admin's invite
 * or recovery link, the status), and anonymous sign-in requests (a magic
 * link, a sign-up).
 */
type CallClass = "operator" | "site" | "anonymous";

/**
 * The broker over its store and configuration. Every method answers what it
 * came to and never throws for a request, a refusal or a failed send.
 */
export function createMailBroker(deps: BrokerDeps) {
	const { store, config } = deps;
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});
	const ledger = createBudgetClient({ store, budget: config.budget, now, log, id: deps.id });

	// THE QUEUE: one call runs at a time, each to its end before the next
	// starts, and a running call is never cut short. Among the calls WAITING,
	// the operator's go first, then the site's, then anonymous sign-in
	// requests, of which at most ANONYMOUS_WAITING_MAX wait: however many
	// sign-in requests arrive, an activation or a retire waits only for the
	// one call running when it came. A site's call that it overtook runs after
	// it, and is held to the generation it left.
	const waiting: Record<CallClass, Array<() => Promise<void>>> = {
		operator: [],
		site: [],
		anonymous: [],
	};
	let running = false;
	/** The next call's number: numbers follow the order calls run in. */
	function nextSeq() {
		const seq = Number(store.get("seq") ?? 0) + 1;
		store.put("seq", seq);
		return seq;
	}
	function pump() {
		if (running) return;
		const next = waiting.operator.shift() ?? waiting.site.shift() ?? waiting.anonymous.shift();
		if (!next) return;
		running = true;
		// `next` never rejects (serial settles its caller's promise itself), so the queue always moves on.
		void (async () => {
			await Promise.resolve();
			await next();
			running = false;
			pump();
		})();
	}
	/** Run `work` in its turn among the calls of its class, numbered as it starts. */
	function serial<T>(cls: CallClass, work: (seq: number) => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			waiting[cls].push(async () => {
				try {
					resolve(await work(nextSeq()));
				} catch (error) {
					reject(error);
				}
			});
			pump();
		});
	}

	const active = () => asGeneration(store.get("active"));
	const staged = () => asGeneration(store.get("staged"));
	const highest = () => Number(store.get("highest") ?? 0);

	/** The SHA-256 of a request's capability, or why it carries none. Nothing is read or written for it. */
	async function capabilityOf(
		r: Record<string, unknown>,
	): Promise<{ hash: string } | { why: string }> {
		if (typeof r.capability !== "string" || !SECRET.test(r.capability))
			return { why: "the request carries no capability" };
		return { hash: await sha256Hex(r.capability) };
	}

	/**
	 * The active generation, when `capabilityHash` is its capability's;
	 * otherwise why not. Only NEW work is held to it: a request id this
	 * capability used before answers what it came to (recalled), whichever
	 * generation is active now.
	 */
	function admit(capabilityHash: string): { gen: Generation } | { why: string } {
		const a = active();
		if (a && a.capabilityHash === capabilityHash) return { gen: a };
		const s = staged();
		if (s && s.capabilityHash === capabilityHash)
			return {
				why: `the capability is generation ${s.generation}'s, which is staged, not active: it sends nothing until the operator activates it`,
			};
		return {
			why: "the capability is not this site's active generation's (it is stale, retired or unknown)",
		};
	}

	/** Remember what a request id came to (on its day), for the capability that asked, and forget ids two days old. */
	function remember(requestId: string, capabilityHash: string, answer: BrokerAnswer) {
		const day = dayOf(now());
		store.put(`op:${day}:${requestId}`, { ...answer, capabilityHash });
		const cut = `op:${dayOf(now() - DAY_MS)}`;
		for (const key of store.keys("op:", 50)) {
			if (key >= cut) break;
			store.delete(key);
		}
	}

	/**
	 * What a request id came to, when this capability used it before: its
	 * answer again (`replayed`). An id another capability used answers nothing
	 * of that (`{ taken: true }`), and nothing is run for it.
	 */
	function recalled(
		requestId: string,
		capabilityHash: string,
	): BrokerAnswer | { taken: true } | null {
		for (const day of [dayOf(now()), dayOf(now() - DAY_MS)]) {
			const seen = store.get(`op:${day}:${requestId}`);
			if (isRecord(seen) && typeof seen.status === "string") {
				const { capabilityHash: by, ...answer } = seen;
				if (by !== capabilityHash) return { taken: true };
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- written by remember() above
				return { ...(answer as unknown as BrokerAnswer), replayed: true };
			}
		}
		return null;
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

	/**
	 * One send of the site's own mail, in its turn: its shape, capability and
	 * request id; what that request id came to before, for this capability,
	 * whichever generation is active now (a retry of a send whose answer was
	 * lost gets that answer, even after an activation); only then, for new
	 * work, the ACTIVE generation's capability, the envelope, the plugin lane's
	 * take, EMAIL_PLUGIN, and the give-back of a send it refused.
	 */
	function send(request: unknown): Promise<BrokerAnswer> {
		return serial("site", async (seq) => {
			const r = isRecord(request) ? request : {};
			if (r.protocol !== AUTH_MAIL_PROTOCOL)
				return refused(
					`the broker speaks protocol ${AUTH_MAIL_PROTOCOL}, and the request names ${JSON.stringify(r.protocol ?? null)}`,
					seq,
				);
			const extra = Object.keys(r).filter((k) => !SEND_FIELDS.has(k));
			if (extra.length)
				return refused(`a send takes no ${extra.map((k) => JSON.stringify(k)).join(", ")}`, seq);
			const cap = await capabilityOf(r);
			if ("why" in cap) return refused(cap.why, seq);
			const capabilityHash = cap.hash;
			const requestId = r.requestId;
			if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
				return refused("a send names its request id (16 to 64 letters, digits, - or _)", seq);
			const seen = recalled(requestId, capabilityHash);
			if (seen && "taken" in seen)
				return refused("that request id was used with another capability", seq);
			if (seen) return seen;
			const got = admit(capabilityHash);
			if ("why" in got) return refused(got.why, seq);
			if ("missing" in config.site) return refused(config.site.missing, seq);
			if ("missing" in config.recipients) return refused(config.recipients.missing, seq);
			if (!config.plugin) return refused("the broker has no EMAIL_PLUGIN binding", seq);
			const env = envelope(r.message, config.site, config.recipients);
			if ("why" in env) return refused(env.why, seq);
			const hashes = await Promise.all(env.recipients.map((a) => sha256Hex(a.toLowerCase())));
			const token = got.gen.tokens.plugin;
			const t = await ledger.take(token, hashes, requestId, {
				lane: "plugin",
				generation: got.gen.generation,
			});
			if ("why" in t) {
				const a = refused(t.why, seq);
				remember(requestId, capabilityHash, a);
				return a;
			}
			// Written before the send: a retry of a send that never finished (the object
			// restarted inside it) is not known to be unsent, so it is not sent again,
			// and its answer says so (`unknown`), never that nothing was sent.
			remember(requestId, capabilityHash, unfinished(seq));
			try {
				await config.plugin.send(env.out);
			} catch (error) {
				await ledger.giveBack(token, requestId, t.takeId);
				const code =
					isRecord(error) && typeof error.code === "string"
						? error.code
						: error instanceof Error
							? error.name
							: "error";
				const a = refused(`EMAIL_PLUGIN refused it (${code})`, seq);
				remember(requestId, capabilityHash, a);
				return a;
			}
			const a: BrokerAnswer = { protocol: AUTH_MAIL_PROTOCOL, status: "sent", seq };
			remember(requestId, capabilityHash, a);
			return a;
		});
	}

	type Operation = "requestMagicLink" | "requestSignup" | "createInvite" | "sendRecovery";

	/**
	 * One auth operation, in its turn: its capability and request id; what
	 * that request id came to before, for this capability (whichever
	 * generation is active now); only then, for new work, the ACTIVE
	 * generation's capability, and ./mediator.ts with that generation's system
	 * lane and EMAIL_SYSTEM. What it came to is remembered under its request
	 * id, and `unknown` is remembered just before EMAIL_SYSTEM is asked to
	 * send: a retry of an operation whose first attempt stopped inside that
	 * send (the object restarted) is neither run again (no second token is
	 * minted, no second message sent) nor said to be unsent, and its place in
	 * the budget and its token stay as they are.
	 */
	function operate(op: Operation, request: unknown): Promise<BrokerAnswer> {
		const cls: CallClass =
			op === "requestMagicLink" || op === "requestSignup" ? "anonymous" : "site";
		if (cls === "anonymous" && waiting.anonymous.length >= ANONYMOUS_WAITING_MAX) {
			return Promise.resolve(
				refused(
					"the broker has as many sign-in requests waiting as it takes: ask again later",
					nextSeq(),
				),
			);
		}
		return serial(cls, async (seq) => {
			const r = isRecord(request) ? request : {};
			if (r.protocol !== AUTH_MAIL_PROTOCOL)
				return refused(
					`the broker speaks protocol ${AUTH_MAIL_PROTOCOL}, and the request names ${JSON.stringify(r.protocol ?? null)}`,
					seq,
				);
			const cap = await capabilityOf(r);
			if ("why" in cap) return refused(cap.why, seq);
			const capabilityHash = cap.hash;
			const requestId = r.requestId;
			if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
				return refused(
					"an operation names its request id (16 to 64 letters, digits, - or _, the same again for a retry of it)",
					seq,
				);
			const seen = recalled(requestId, capabilityHash);
			if (seen && "taken" in seen)
				return refused("that request id was used with another capability", seq);
			if (seen) return seen;
			const got = admit(capabilityHash);
			if ("why" in got) return refused(got.why, seq);
			if (!deps.db) return refused("the broker has no DB binding", seq);
			const { capability: _capability, requestId: _requestId, ...rest } = r;
			const gen = got.gen;
			const mediator = createAuthMailMediator({
				db: deps.db,
				sessions: deps.sessions,
				// The system lane of THIS generation, through the broker's own take and owed give-back.
				budget: config.budget
					? ledger.lane(gen.tokens.system, { lane: "system", generation: gen.generation })
					: { missing: "the broker has no service binding MAIL_BUDGET" },
				send: config.system,
				site: config.site,
				now,
				log,
				// From here on its message may have gone: a retry answers `unknown`, never runs it again.
				sending: () => remember(requestId, capabilityHash, unfinished(seq)),
			});
			const a: AuthMailAnswer = await mediator[op](rest);
			const answer: BrokerAnswer = { ...a, seq };
			remember(requestId, capabilityHash, answer);
			return answer;
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
		return serial("site", async (seq) => {
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

	/** The broker's state as the admin door answers it: numbers and hashes, never a token, and how many give-backs it owes the budget. */
	const state = (seq: number) => ({
		ok: true,
		seq,
		tenant: config.tenant,
		deployment: config.deployment,
		active: view(active()),
		staged: view(staged()),
		highest: highest(),
		owedRefunds: ledger.owed(),
	});

	const conflict = (why: string, seq: number) =>
		json(409, { ...state(seq), ok: false, conflict: true, why });

	/** The answer of a fence that still owes the budget give-backs of earlier sends: not an acknowledgement. */
	const owing = (seq: number, owed: number, extra: Record<string, unknown> = {}) =>
		json(503, {
			...state(seq),
			...extra,
			ok: false,
			error: `${owed} give-back(s) of places earlier sends took are not yet known to be done: this answer waits for them; ask again`,
		});

	/**
	 * The operator's door, behind BROKER_ADMIN_SECRET:
	 *   GET  /admin/state      the active and staged generations (numbers and hashes), the highest ever staged,
	 *                          how many give-backs it owes the budget (`owedRefunds`), `seq`
	 *   POST /admin/stage      { generation, capabilityHash, tokens: { plugin, system }, expectActive }
	 *                          stage a generation after every one before it, while `expectActive` is the active
	 *                          one's number (null for none); its tokens must be this site's, that generation's,
	 *                          STAGED lanes in the budget. Replaces any other staged one.
	 *   POST /admin/activate   { generation, capabilityHash, expectActive }: the staged one active, in its turn
	 *                          (after every call before it ended), while `expectActive` is the active one's
	 *                          number, once every give-back an earlier send owes the budget is settled (503 until then)
	 *   POST /admin/retire     { generation }: that generation, active or staged, no longer counts, at once; answered
	 *                          200 once every give-back an earlier send owes is settled (503, retired, until then)
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
			return serial("operator", async (seq) => json(200, state(seq)));
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
			return serial("operator", async (seq) => {
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
			return serial("operator", async (seq) => {
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
				// Inside the fence: every give-back an earlier send owes is settled before the activation is.
				const owed = await ledger.settleOwed();
				if (owed) return owing(seq, owed);
				const why = await lanesRefused(s, ["staged", "active"]);
				if (why) return json(400, { ...state(seq), ok: false, error: why });
				store.put("active", { ...s, at: new Date(now()).toISOString() });
				store.delete("staged");
				log(`mail broker: generation ${g} is active (seq ${seq})`);
				return json(200, { ...state(seq), unchanged: false });
			});
		}
		return serial("operator", async (seq) => {
			const a = active();
			const s = staged();
			const retired = [a?.generation === g && "active", s?.generation === g && "staged"].filter(
				(x): x is string => Boolean(x),
			);
			if (a?.generation === g) store.delete("active");
			if (s?.generation === g) store.delete("staged");
			// Retired at once (nothing after this counts); acknowledged once every give-back an earlier send owes is settled.
			const owed = await ledger.settleOwed();
			if (owed) return owing(seq, owed, { retired });
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
