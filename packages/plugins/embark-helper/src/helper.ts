/**
 * The AI Helper's admin route: one Block Kit handler for the page and the
 * dashboard widget. Every answer comes from Embark's control plane; the
 * plugin keeps only the link key an Embark operator wrote and, for a day, a
 * claim for each question asked.
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
const NON_ASCII = /[\u007f-￿]/g;
/**
 * A turn's claim on its form's nonce, the KV row `turn:<nonce>`: `{ at }`
 * while the turn runs, `{ at, outcome }` once it is done. Only the request
 * that creates the row asks Embark; a second submit of the same form waits
 * for the first one's outcome and shows it. Rows older than a day are cleared.
 */
const CLAIM = "turn:";
const CLAIM_KEPT_MS = 86_400_000;
const CLAIM_POLL_MS = 1_000;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NO_KEY = "The AI Helper comes with Embark hosting.";
const EDITORS_ONLY = "The AI Helper is for this site's editors and administrators.";
const TRY_AGAIN = "Try again in a minute.";
const UNREADABLE = `The AI Helper could not read Embark's answer. ${TRY_AGAIN}`;
const OUT_OF_DATE = "This page was out of date, so the question was not sent. Ask it again.";
const STILL_ANSWERING =
	"That question is already being answered. Reload this page in a minute to see the reply.";

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
	} catch (error) {
		ctx.log.warn("embark-helper: the link key row could not be read", { error: messageOf(error) });
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
		ctx.log.warn(`embark-helper: ${op} did not reach Embark`, { error: messageOf(error) });
		const timedOut = isRecord(error) && error.name === "TimeoutError";
		return {
			failed: timedOut
				? `Embark did not answer in time. ${TRY_AGAIN}`
				: `The request to Embark did not go through. ${TRY_AGAIN}`,
		};
	}
	const data: unknown = await res.json().catch(() => undefined);
	const refused = refusalOf(data);
	if (refused) return { refused };
	if (!res.ok) return { failed: `Embark answered with status ${res.status}. ${TRY_AGAIN}` };
	return isRecord(data) ? { data } : { failed: UNREADABLE };
}

async function turnOf(message: string, ask: Ask): Promise<Outcome> {
	const a = await ask("turn", { message });
	if (!("data" in a)) return { answer: a };
	const { reply, proposals } = a.data;
	if (typeof reply !== "string") return { answer: { failed: UNREADABLE } };
	return { turn: { message, reply, proposals: proposalsOf(proposals) } };
}

/** The outcome the turn holding `claim` recorded, or `null` if none is recorded in time. */
async function settledOf(ctx: HelperContext, claim: string): Promise<Outcome | null> {
	const until = Date.now() + TURN_TIMEOUT_MS + OP_TIMEOUT_MS;
	for (;;) {
		const row = await ctx.kv.get<unknown>(claim).catch(() => null);
		if (isRecord(row) && isRecord(row.outcome)) return row.outcome as Outcome;
		if (Date.now() >= until) return null;
		await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
	}
}

/** Clears claims older than a day. A failure here is logged and never stops the turn. */
async function sweepClaims(ctx: HelperContext): Promise<void> {
	const oldest = Date.now() - CLAIM_KEPT_MS;
	try {
		const rows = await ctx.kv.list(CLAIM);
		await Promise.all(
			rows
				.filter(({ value: v }) => !(isRecord(v) && typeof v.at === "number" && v.at >= oldest))
				.map(({ key }) => ctx.kv.delete(key)),
		);
	} catch (error) {
		ctx.log.warn("embark-helper: old question claims could not be cleared", {
			error: messageOf(error),
		});
	}
}

/**
 * Asks once per form: the request that claims the form's nonce runs the turn,
 * and a second submit of that form shows the first one's outcome.
 */
async function asked(
	ctx: HelperContext,
	input: Record<string, unknown>,
	ask: Ask,
): Promise<Outcome> {
	const { block_id: block, values } = input;
	const raw = isRecord(values) ? values.message : undefined;
	const message = typeof raw === "string" ? raw.trim() : "";
	if (!message) return { banner: notice("Write a question or a request first.") };
	const nonce =
		typeof block === "string" && block.startsWith(ASK_FORM) ? block.slice(ASK_FORM.length) : "";
	if (!NONCE.test(nonce)) return { banner: notice(OUT_OF_DATE) };
	const claim = `${CLAIM}${nonce}`;
	const at = Date.now();
	const held = await ctx.kv.compareAndSet(claim, null, { at }).then(
		(w) => w.applied,
		(error: unknown) => {
			ctx.log.warn("embark-helper: the question could not be claimed", {
				error: messageOf(error),
			});
			return null;
		},
	);
	if (held === null)
		return { answer: { failed: `The AI Helper could not start this question. ${TRY_AGAIN}` } };
	if (!held) return (await settledOf(ctx, claim)) ?? { banner: notice(STILL_ANSWERING) };
	await sweepClaims(ctx);
	const outcome = await turnOf(message, ask);
	await ctx.kv.set(claim, { at, outcome }).catch((error: unknown) =>
		ctx.log.warn("embark-helper: the answered question could not be recorded", {
			error: messageOf(error),
		}),
	);
	return outcome;
}

/** Does what the interaction asked, and says how it went. */
async function act(
	ctx: HelperContext,
	input: Record<string, unknown>,
	ask: Ask,
	admin: boolean,
): Promise<Outcome> {
	const { type, action_id: action, value } = input;
	if (type === "form_submit" && action === "ask") return asked(ctx, input, ask);
	if (type !== "block_action") return {};
	if (action === "approve" || action === "reject") {
		if (typeof value !== "string" || value === "") return {};
		const a = await ask(action, { proposalId: value });
		if (!("data" in a)) return { answer: a };
		return { toast: action === "approve" ? "Approved" : "Discarded" };
	}
	if (action === "toggle") {
		if (!admin)
			return { banner: notice("Only an administrator can turn the AI Helper on or off.") };
		const a = await ask("toggle", { enabled: value === true });
		if (!("data" in a)) return { answer: a };
		const on = typeof a.data.enabled === "boolean" ? a.data.enabled : value === true;
		return { toast: on ? "The AI Helper is on" : "The AI Helper is off" };
	}
	return {};
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
	const outcome = await act(ctx, input, ask, admin);
	return helperPage(await ask("overview", {}), outcome, admin);
}
