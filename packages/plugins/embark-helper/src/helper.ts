/**
 * The AI Helper's admin route: one Block Kit handler for the page and the
 * dashboard widget. Every answer comes from Embark's control plane; the
 * plugin keeps nothing of its own but the link key an Embark operator wrote.
 */

import type { BlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";

import {
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

const NO_KEY = "The AI Helper comes with Embark hosting.";
const EDITORS_ONLY = "The AI Helper is for this site's editors and administrators.";
const TRY_AGAIN = "Try again in a minute.";
const UNREADABLE = `The AI Helper could not read Embark's answer. ${TRY_AGAIN}`;

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

/** Does what the interaction asked, and says how it went. */
async function act(input: Record<string, unknown>, ask: Ask, admin: boolean): Promise<Outcome> {
	const { type, action_id: action, value, values } = input;
	if (type === "form_submit" && action === "ask") {
		const raw = isRecord(values) ? values.message : undefined;
		const message = typeof raw === "string" ? raw.trim() : "";
		if (!message) return { banner: notice("Write a question or a request first.") };
		const a = await ask("turn", { message });
		if (!("data" in a)) return { answer: a };
		const { reply, proposals } = a.data;
		if (typeof reply !== "string") return { answer: { failed: UNREADABLE } };
		return { turn: { message, reply, proposals: proposalsOf(proposals) } };
	}
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
	const outcome = await act(input, ask, admin);
	return helperPage(await ask("overview", {}), outcome, admin);
}
