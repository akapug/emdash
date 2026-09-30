/**
 * The AI Helper's admin route: one Block Kit handler for the page and the
 * dashboard widget. Every answer comes from Embark's control plane; the
 * plugin keeps only the link key an Embark operator wrote, a pending request
 * id for safe retries, and short-lived coordination claims while turns run.
 */

import type { BlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";

import {
	ASK_FORM,
	type Answer,
	errorPage,
	helperPage,
	helperWidget,
	notice,
	type Outcome,
	proposalsOf,
	sentence,
} from "./page.js";

export type HelperContext = Pick<RouteContext, "input" | "user" | "kv" | "http" | "log">;

type Op = "overview" | "turn" | "approve" | "reject" | "toggle";
type Ask = (op: Op, body: Record<string, unknown>) => Promise<Answer>;

interface ReplayTicket {
	at: number;
	fingerprint: string;
	requestId: string;
}

interface StoredClaim {
	at: number;
	outcome?: Outcome;
	requestId: string;
}

interface ActionResult {
	claim?: string;
	outcome: Outcome;
}

const CONTROL_PLANE = "https://embarkeasy.com/api/tenant-helper/";
/** The plugin's KV row an Embark operator writes: the options row `plugin:embark-helper:linkKey`. */
export const LINK_KEY = "linkKey";
const EDITOR = 40;
const ADMIN = 50;
const ROLE_NAMES: Record<number, string> = {
	10: "subscriber",
	20: "contributor",
	30: "author",
	40: "editor",
	50: "admin",
};
/** A turn runs the model and its tools; every other op is one read or one write. */
const TURN_TIMEOUT_MS = 90_000;
const OP_TIMEOUT_MS = 20_000;
const NON_ASCII = /[\u007f-\uffff]/g;
/**
 * A turn's claim on its form's nonce, the KV row `turn:<nonce>`: `{ at }`
 * while the turn runs, `{ at, outcome }` once it is done. Only the request
 * that creates the row asks Embark; a second submit of the same form waits
 * for the first one's outcome and shows it. Rendered rows are deleted, with a
 * day-old sweep as the backstop when cleanup fails.
 */
const CLAIM = "turn:";
const REPLAY = "request:";
const CLAIM_KEPT_MS = 86_400_000;
const REPLAY_KEPT_MS = 15 * 60_000;
const CLAIM_POLL_MS = 1_000;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NO_KEY = "The AI Helper comes with Embark hosting.";
const EDITORS_ONLY = "The AI Helper is for this site's editors and administrators.";
const TRY_AGAIN = "Try again in a minute.";
const UNREADABLE = "The AI Helper could not read Embark's answer.";
/** What a non-2xx answer without a refusal means, where trying again cannot fix it. */
const STATUS_WORDS: Record<number, string> = {
	401: "Embark did not accept this site's link. Embark support can relink it.",
	403: "Embark did not accept this site's link. Embark support can relink it.",
	413: "That message is too long for the AI Helper.",
};
const OUT_OF_DATE = "This page was out of date, so the question was not sent. Ask it again.";
const STILL_ANSWERING =
	"The AI Helper did not finish recording that question. Ask it again to safely check for its reply.";
const CLAIM_UNREADABLE =
	"The AI Helper could not read the saved state for that question. Ask it again in a minute.";
const SAVE_FAILED =
	"The AI Helper received an answer but could not save its coordination state. The reply is shown below, and retrying this form is safe.";

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON a header can carry: every character past ASCII as a `\u` escape, which parses back the same. */
const asciiJson = (value: unknown) =>
	JSON.stringify(value).replace(
		NON_ASCII,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

/** The link key, `null` while Embark has not linked the site, or why it could not be read. */
async function linkKeyOf(ctx: HelperContext): Promise<string | null | { failed: string }> {
	try {
		const v = await ctx.kv.get<unknown>(LINK_KEY);
		return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
	} catch {
		ctx.log.warn("embark-helper: the link key row could not be read");
		return {
			failed: "This site's link to Embark could not be read. Embark support can relink it.",
		};
	}
}

/** A refusal, whatever the status it came with; its message is shown as it came. */
function refusalOf(body: unknown): { reason: string; message: string } | null {
	if (!isRecord(body) || !isRecord(body.refused)) return null;
	const reason = typeof body.refused.reason === "string" ? body.refused.reason : "";
	const message = body.refused.message;
	return {
		reason,
		message:
			typeof message === "string" && message.trim() !== ""
				? message
				: `The AI Helper did not do that (${reason || "no reason given"}).`,
	};
}

async function call(
	ctx: HelperContext,
	key: string,
	user: NonNullable<HelperContext["user"]>,
	op: Op,
	body: Record<string, unknown>,
): Promise<Answer> {
	if (!ctx.http) return { failed: "This site does not let the AI Helper reach Embark." };
	let res: Response;
	try {
		res = await ctx.http.fetch(`${CONTROL_PLANE}${op}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
				accept: "application/json",
				"x-embark-user": asciiJson({
					id: user.id,
					email: user.email,
					role: ROLE_NAMES[user.role] ?? String(user.role),
				}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(op === "turn" ? TURN_TIMEOUT_MS : OP_TIMEOUT_MS),
		});
	} catch (error) {
		ctx.log.warn(`embark-helper: ${op} did not reach Embark`);
		const timedOut = isRecord(error) && error.name === "TimeoutError";
		return {
			failed: timedOut
				? `Embark did not answer in time. ${TRY_AGAIN}`
				: `The request to Embark did not go through. ${TRY_AGAIN}`,
			retry: true,
		};
	}
	const data: unknown = await res.json().catch(() => undefined);
	const refused = refusalOf(data);
	if (refused) return { refused };
	if (!res.ok) return statusFailure(res.status, data);
	return isRecord(data) ? { data } : { failed: UNREADABLE };
}

/** A non-2xx answer: "Try again" only for a busy or broken Embark (429, 5xx), where it can help. */
function statusFailure(status: number, body?: unknown): Answer {
	const words = STATUS_WORDS[status];
	if (words) return { failed: words };
	const message =
		isRecord(body) && typeof body.message === "string" && body.message.trim() !== ""
			? body.message.trim()
			: `Embark answered with status ${status}.`;
	return status === 429 || status >= 500
		? { failed: `${message} ${TRY_AGAIN}`, retry: true }
		: { failed: message };
}

async function turnOf(message: string, requestId: string, ask: Ask): Promise<Outcome> {
	const a = await ask("turn", { message, request_id: requestId });
	if (!("data" in a)) return { answer: a };
	const { reply, proposals } = a.data;
	if (typeof reply !== "string") return { answer: { failed: UNREADABLE } };
	return { turn: { message, reply, proposals: proposalsOf(proposals) } };
}

function storedClaim(v: unknown): StoredClaim | null {
	if (!isRecord(v)) return null;
	const { at, outcome, requestId } = v;
	if (typeof at !== "number" || typeof requestId !== "string") return null;
	return {
		at,
		requestId,
		...(isRecord(outcome) ? { outcome } : {}),
	};
}

/** The outcome the turn holding `claim` recorded, or `null` if none is recorded in time. */
async function settledOf(
	ctx: HelperContext,
	claim: string,
): Promise<StoredClaim | null | undefined> {
	const until = Date.now() + TURN_TIMEOUT_MS + OP_TIMEOUT_MS;
	for (;;) {
		let row: unknown;
		try {
			row = await ctx.kv.get<unknown>(claim);
		} catch {
			ctx.log.warn("embark-helper: the question claim could not be read");
			await ctx.kv
				.delete(claim)
				.catch(() => ctx.log.warn("embark-helper: the broken question claim could not be cleared"));
			return undefined;
		}
		if (row === null) return null;
		const stored = storedClaim(row);
		if (stored?.outcome) return stored;
		if (Date.now() >= until) {
			await ctx.kv
				.delete(claim)
				.catch(() => ctx.log.warn("embark-helper: the broken question claim could not be cleared"));
			return null;
		}
		await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
	}
}

/** Clears day-old claims and pending retries past the control plane's 15-minute window. */
async function sweepClaims(ctx: HelperContext): Promise<void> {
	const oldestClaim = Date.now() - CLAIM_KEPT_MS;
	const oldestReplay = Date.now() - REPLAY_KEPT_MS;
	try {
		const rows = await Promise.all([ctx.kv.list(CLAIM), ctx.kv.list(REPLAY)]);
		await Promise.all(
			rows
				.flat()
				.filter(({ key, value: v }) => {
					const oldest = key.startsWith(CLAIM) ? oldestClaim : oldestReplay;
					return !(isRecord(v) && typeof v.at === "number" && v.at >= oldest);
				})
				.map(({ key }) => ctx.kv.delete(key)),
		);
	} catch {
		ctx.log.warn("embark-helper: old question state could not be cleared");
	}
}

async function fingerprintOf(
	user: NonNullable<HelperContext["user"]>,
	message: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify([user.id, user.email, user.role, message]));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ticketOf(
	ctx: HelperContext,
	nonce: string,
	user: NonNullable<HelperContext["user"]>,
	message: string,
): Promise<ReplayTicket | null> {
	const key = `${REPLAY}${nonce}`;
	const fingerprint = await fingerprintOf(user, message);
	for (;;) {
		const current = await ctx.kv.getVersioned<unknown>(key);
		if (current) {
			const ticket = current.value;
			if (
				isRecord(ticket) &&
				typeof ticket.at === "number" &&
				Date.now() - ticket.at < REPLAY_KEPT_MS &&
				typeof ticket.fingerprint === "string" &&
				typeof ticket.requestId === "string" &&
				NONCE.test(ticket.requestId)
			)
				return ticket.fingerprint === fingerprint
					? {
							at: ticket.at,
							fingerprint,
							requestId: ticket.requestId,
						}
					: null;
			if (!(await ctx.kv.compareAndDelete(key, current.revision)).applied) continue;
		}
		const ticket: ReplayTicket = { at: Date.now(), fingerprint, requestId: crypto.randomUUID() };
		if ((await ctx.kv.compareAndSet(key, null, ticket)).applied) return ticket;
	}
}

/**
 * Asks once per form: the request that claims the form's nonce runs the turn,
 * and a second submit of that form shows the first one's outcome.
 */
const retryForm = (outcome: Outcome, nonce: string): Outcome =>
	outcome.answer && "failed" in outcome.answer && outcome.answer.retry === true
		? { ...outcome, askNonce: nonce }
		: outcome;

async function asked(
	ctx: HelperContext,
	input: Record<string, unknown>,
	ask: Ask,
	user: NonNullable<HelperContext["user"]>,
): Promise<ActionResult> {
	const { block_id: block, values } = input;
	const raw = isRecord(values) ? values.message : undefined;
	const message = typeof raw === "string" ? raw.trim() : "";
	if (!message) return { outcome: { banner: notice("Write a question or a request first.") } };
	const nonce =
		typeof block === "string" && block.startsWith(ASK_FORM) ? block.slice(ASK_FORM.length) : "";
	if (!NONCE.test(nonce)) return { outcome: { banner: notice(OUT_OF_DATE) } };
	let ticket: ReplayTicket | null;
	try {
		ticket = await ticketOf(ctx, nonce, user, message);
	} catch {
		ctx.log.warn("embark-helper: the question id could not be saved");
		return {
			outcome: {
				askNonce: nonce,
				answer: {
					failed: `The AI Helper could not start this question. ${TRY_AGAIN}`,
					retry: true,
				},
			},
		};
	}
	if (!ticket) return { outcome: { banner: notice(OUT_OF_DATE) } };
	const claim = `${CLAIM}${nonce}`;
	const row: StoredClaim = { at: Date.now(), requestId: ticket.requestId };
	const held = await ctx.kv.compareAndSet(claim, null, row).then(
		(w) => w.applied,
		() => {
			ctx.log.warn("embark-helper: the question could not be claimed");
			return null;
		},
	);
	if (held === null)
		return {
			outcome: {
				askNonce: nonce,
				answer: {
					failed: `The AI Helper could not start this question. ${TRY_AGAIN}`,
					retry: true,
				},
			},
		};
	if (!held) {
		const stored = await settledOf(ctx, claim);
		if (stored === undefined)
			return {
				outcome: { askNonce: nonce, answer: { failed: CLAIM_UNREADABLE, retry: true } },
			};
		if (!stored?.outcome)
			return { outcome: { askNonce: nonce, answer: { failed: STILL_ANSWERING, retry: true } } };
		return { claim, outcome: retryForm(stored.outcome, nonce) };
	}
	await sweepClaims(ctx);
	const outcome = await turnOf(message, ticket.requestId, ask);
	try {
		await ctx.kv.set(claim, { ...row, outcome });
	} catch {
		ctx.log.warn("embark-helper: the answered question could not be recorded");
		await ctx.kv
			.delete(claim)
			.catch(() => ctx.log.warn("embark-helper: the broken question claim could not be cleared"));
		return { outcome: { ...outcome, askNonce: nonce, banner: notice(SAVE_FAILED) } };
	}
	return { claim, outcome: retryForm(outcome, nonce) };
}

/** Does what the interaction asked, and says how it went. */
async function act(
	ctx: HelperContext,
	input: Record<string, unknown>,
	ask: Ask,
	admin: boolean,
	user: NonNullable<HelperContext["user"]>,
): Promise<ActionResult> {
	const { type, action_id: action, value } = input;
	if (type === "form_submit" && action === "ask") return asked(ctx, input, ask, user);
	if (type !== "block_action") return { outcome: {} };
	if (action === "approve" || action === "reject") {
		if (typeof value !== "string" || value === "") return { outcome: {} };
		const a = await ask(action, { proposalId: value });
		if (!("data" in a)) return { outcome: { answer: a } };
		if (a.data.ok !== true) return { outcome: { answer: { failed: UNREADABLE } } };
		return { outcome: { toast: action === "approve" ? "Approved" : "Discarded" } };
	}
	if (action === "toggle") {
		if (!admin)
			return {
				outcome: { banner: notice("Only an administrator can turn the AI Helper on or off.") },
			};
		const a = await ask("toggle", { enabled: value === true });
		if (!("data" in a)) return { outcome: { answer: a } };
		const { enabled } = a.data;
		if (typeof enabled !== "boolean") return { outcome: { answer: { failed: UNREADABLE } } };
		return { outcome: { toast: enabled ? "The AI Helper is on" : "The AI Helper is off" } };
	}
	return { outcome: {} };
}

/** The admin route: the page (`/`) and the dashboard widget (`widget:allowance`). */
export async function helperAdmin(ctx: HelperContext): Promise<BlockResponse> {
	const input = isRecord(ctx.input) ? ctx.input : {};
	const widget = typeof input.page === "string" && input.page.startsWith("widget:");
	const key = await linkKeyOf(ctx);
	if (key === null) return sentence(NO_KEY);
	if (typeof key !== "string") return errorPage(key.failed, widget);
	const user = ctx.user;
	if (!user || user.role < EDITOR) return sentence(EDITORS_ONLY);
	const ask: Ask = (op, body) => call(ctx, key, user, op, body);
	if (widget) return helperWidget(await ask("overview", {}));
	const admin = user.role >= ADMIN;
	const action = await act(ctx, input, ask, admin, user);
	const page = helperPage(await ask("overview", {}), action.outcome, admin);
	if (action.claim) {
		await ctx.kv
			.delete(action.claim)
			.catch(() => ctx.log.warn("embark-helper: the rendered question claim could not be cleared"));
	}
	return page;
}
