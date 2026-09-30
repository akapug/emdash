/**
 * The AI Helper's Block Kit: the admin page and the dashboard widget, built
 * from the control plane's `overview` and whatever the last interaction did.
 */

import type { Block, BlockResponse } from "@emdash-cms/blocks/server";

/** What one call to the control plane came to. `retry` marks a failure that trying again can fix. */
export type Answer =
	| { data: Record<string, unknown> }
	| { refused: { reason: string; message: string } }
	| { failed: string; retry?: boolean };

export interface Proposal {
	id: string;
	kind: string;
	summary: string;
	preview: string;
}

interface Turn {
	role: "user" | "assistant";
	text: string;
	at: unknown;
}

interface Allowance {
	usedCents: number;
	limitCents: number;
	resetsOn: string;
	plan: string;
	earlyAdopter: boolean;
}

/** What the interaction before this render did. */
export interface Outcome {
	/** Reuse this form nonce when a retriable turn may already have reached Embark. */
	askNonce?: string;
	/** A notice the plugin raised itself, before asking Embark anything. */
	banner?: Block;
	/** Embark's refusal, or the failure to reach it. */
	answer?: Exclude<Answer, { data: Record<string, unknown> }>;
	toast?: string;
	turn?: { message: string; reply: string; proposals: Proposal[] };
}

const LAST_TURNS = 10;
const UNDERSCORES = /_+/g;
const LINE_BREAK = /\r?\n/;
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});

const RETRY: Block = {
	type: "actions",
	elements: [{ type: "button", action_id: "reload", label: "Try again" }],
};
const OPEN_PAGE: Block = {
	type: "actions",
	elements: [
		{ type: "link", label: "Open the AI Helper", target: { kind: "plugin-page", path: "/" } },
	],
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const sentence = (text: string): BlockResponse => ({ blocks: [{ type: "section", text }] });

export const notice = (description: string): Block => ({
	type: "banner",
	variant: "alert",
	description,
});

const failure = (description: string): Block => ({
	type: "banner",
	variant: "error",
	title: "The AI Helper is unavailable",
	description,
});

/** Over a refused request; a refused overview answers nobody's request. */
const REFUSED = "The AI Helper did not do that";
const UNAVAILABLE = "The AI Helper is not available";

/** A refusal shows the server's message as it came, under `title`. */
function answerBanner(
	a: Exclude<Answer, { data: Record<string, unknown> }>,
	title = REFUSED,
): Block {
	return "refused" in a
		? { type: "banner", variant: "alert", title, description: a.refused.message }
		: failure(a.failed);
}

export const errorPage = (description: string, widget: boolean): BlockResponse => ({
	blocks: widget
		? [failure(description)]
		: [{ type: "header", text: "AI Helper" }, failure(description), RETRY],
});

function dayOf(value: string): string {
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? value : DAY.format(d);
}

function whenOf(at: unknown): string {
	if (typeof at !== "string" && typeof at !== "number") return "";
	const d = new Date(at);
	return Number.isNaN(d.getTime()) ? "" : `${TIME.format(d)} UTC`;
}

export function proposalsOf(value: unknown): Proposal[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((p) =>
		isRecord(p) && typeof p.id === "string" && p.id !== ""
			? [
					{
						id: p.id,
						kind: typeof p.kind === "string" ? p.kind : "",
						summary:
							typeof p.summary === "string" && p.summary.trim() !== ""
								? p.summary
								: "A proposed change",
						preview: typeof p.preview === "string" ? p.preview : "",
					},
				]
			: [],
	);
}

/** The conversation shows the user's and the Helper's rows only: never a tool, system or unnamed one. */
function turnsOf(value: unknown): Turn[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((t): Turn[] =>
		isRecord(t) &&
		(t.role === "user" || t.role === "assistant") &&
		typeof t.text === "string" &&
		t.text.trim() !== ""
			? [{ role: t.role, text: t.text, at: t.at }]
			: [],
	);
}

function allowanceOf(value: unknown): Allowance | null {
	if (!isRecord(value)) return null;
	const { usedCents, limitCents } = value;
	if (typeof usedCents !== "number" || !Number.isFinite(usedCents)) return null;
	if (typeof limitCents !== "number" || !Number.isFinite(limitCents)) return null;
	return {
		usedCents,
		limitCents,
		resetsOn: typeof value.resetsOn === "string" ? value.resetsOn : "",
		plan: typeof value.plan === "string" ? value.plan : "",
		earlyAdopter: value.earlyAdopter === true,
	};
}

/**
 * What a turn adds to the conversation: the question, and the reply. A blank
 * reply is never an empty bubble: it names the changes it drafted, or is left
 * out when it drafted none.
 */
function rowsOf(turn: NonNullable<Outcome["turn"]>): Turn[] {
	const n = turn.proposals.length;
	const reply =
		turn.reply.trim() !== ""
			? turn.reply
			: n > 0
				? `Drafted ${n} ${n === 1 ? "change" : "changes"} for your approval below.`
				: "";
	return [
		{ role: "user", text: turn.message, at: null },
		...(reply ? [{ role: "assistant" as const, text: reply, at: null }] : []),
	];
}

/** Does the overview have the last turn yet? A blank reply leaves no row to find, so its question is the sign. */
function caughtUp(turns: Turn[], turn: NonNullable<Outcome["turn"]>): boolean {
	return turn.reply.trim() === ""
		? turns.findLast((t) => t.role === "user")?.text === turn.message
		: turns.some((t) => t.role === "assistant" && t.text === turn.reply);
}

/** The overview, with the last turn's reply and proposals added if the overview does not have them yet. */
function overviewOf(data: Record<string, unknown>, turn?: Outcome["turn"]) {
	const turns = turnsOf(data.turns);
	const proposals = proposalsOf(data.proposals);
	return {
		enabled: data.enabled !== false,
		allowance: allowanceOf(data.allowance),
		turns: (!turn || caughtUp(turns, turn) ? turns : [...turns, ...rowsOf(turn)]).slice(
			-LAST_TURNS,
		),
		proposals: [
			...proposals,
			...(turn?.proposals ?? []).filter((p) => !proposals.some((q) => q.id === p.id)),
		],
	};
}

/**
 * The allowance, as a share of this month's: never an amount of money. The
 * share rounds down, so "100% used" means the allowance is used up; a plan
 * with no allowance reads 100% and says so.
 */
function allowanceBlocks(a: Allowance | null): Block[] {
	if (!a) return [];
	const none = a.limitCents <= 0;
	const pct = none
		? 100
		: Math.min(100, Math.max(0, Math.floor((a.usedCents * 100) / a.limitCents)));
	const line = [
		none ? "No Helper allowance on this plan" : "",
		a.plan ? `${a.plan} plan` : "",
		a.resetsOn ? `Resets ${dayOf(a.resetsOn)}` : "",
		a.earlyAdopter ? "Early adopter" : "",
	]
		.filter(Boolean)
		.join(" · ");
	return [
		{
			type: "meter",
			label: "This month's allowance",
			value: pct,
			max: 100,
			custom_value: `${pct}% used`,
		},
		...(line ? [{ type: "context" as const, text: line }] : []),
	];
}

function turnBlocks(turns: Turn[]): Block[] {
	if (turns.length === 0) return [{ type: "context", text: "Nothing asked yet." }];
	return turns.flatMap((t): Block[] => {
		const who = t.role === "user" ? "Asked" : "AI Helper";
		const when = whenOf(t.at);
		// A section shows its text as one run, so each line of a turn gets its own.
		const lines = t.text.split(LINE_BREAK).filter((l) => l.trim() !== "");
		return [
			{ type: "context", text: when ? `${who} · ${when}` : who },
			...lines.map((l): Block => ({ type: "section", text: l })),
		];
	});
}

function proposalBlocks(proposals: Proposal[]): Block[] {
	if (proposals.length === 0)
		return [{ type: "context", text: "Nothing is waiting for approval." }];
	return proposals.flatMap((p): Block[] => {
		const kind = p.kind.replace(UNDERSCORES, " ").trim();
		const detail = [kind && kind.charAt(0).toUpperCase() + kind.slice(1), p.preview]
			.filter(Boolean)
			.join(" — ");
		return [
			{ type: "section", text: p.summary },
			...(detail ? [{ type: "context" as const, text: detail }] : []),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "approve",
						label: "Approve",
						style: "primary",
						value: p.id,
						confirm: {
							title: "Approve this change?",
							text: p.summary,
							confirm: "Approve",
							deny: "Cancel",
						},
					},
					{
						type: "button",
						action_id: "reject",
						label: "Discard",
						style: "secondary",
						value: p.id,
					},
				],
			},
		];
	});
}

function switchBlocks(enabled: boolean, admin: boolean): Block[] {
	const off: Block[] = enabled
		? []
		: [
				{
					type: "banner",
					title: "The AI Helper is off",
					description: admin
						? "Turn it on with the switch below to ask it things."
						: "An administrator can turn it on.",
				},
			];
	if (admin)
		return [
			...off,
			{
				type: "actions",
				elements: [
					{
						type: "toggle",
						action_id: "toggle",
						label: "AI Helper",
						description: "Turns the AI Helper on or off for everyone on this site.",
						initial_value: enabled,
					},
				],
			},
		];
	return enabled
		? [{ type: "context", text: "The AI Helper is on. An administrator can turn it off." }]
		: off;
}

/**
 * The ask form's block id: this prefix and a nonce made fresh on every render.
 * A turn claims the nonce before it runs, so one form asks once however often
 * its button is pressed, and each new form mounts with an empty box.
 */
export const ASK_FORM = "ask:";

const askForm = (nonce: string = crypto.randomUUID()): Block => ({
	type: "form",
	block_id: `${ASK_FORM}${nonce}`,
	fields: [
		{
			type: "text_input",
			action_id: "message",
			label: "Ask the AI Helper",
			placeholder: "For example: fix the typos on the About page",
			multiline: true,
		},
	],
	submit: { label: "Ask", action_id: "ask" },
});

/** The AI Helper page. */
export function helperPage(overview: Answer, outcome: Outcome, admin: boolean): BlockResponse {
	const alerts = [
		...(outcome.banner ? [outcome.banner] : []),
		...(outcome.answer ? [answerBanner(outcome.answer)] : []),
		...("data" in overview ? [] : [answerBanner(overview, UNAVAILABLE)]),
	];
	const failures = [outcome.answer, "data" in overview ? undefined : overview];
	if (failures.some((a) => a !== undefined && "failed" in a && a.retry === true))
		alerts.push(RETRY);

	const o = "data" in overview ? overviewOf(overview.data, outcome.turn) : null;
	// The switch is the one way back on for an administrator who turned the Helper off.
	const switchOn = admin && "refused" in overview && overview.refused.reason === "helper_off";
	const body: Block[] = o
		? [
				...switchBlocks(o.enabled, admin),
				...allowanceBlocks(o.allowance),
				...(o.enabled ? [{ type: "divider" as const }, askForm(outcome.askNonce)] : []),
				{ type: "divider" },
				{ type: "header", text: "Recent conversation" },
				...turnBlocks(o.turns),
				{ type: "divider" },
				{ type: "header", text: "Waiting for approval" },
				...proposalBlocks(o.proposals),
			]
		: [
				...(switchOn ? switchBlocks(false, true) : []),
				...(outcome.askNonce ? [askForm(outcome.askNonce), { type: "divider" as const }] : []),
				// The page could not be refreshed: keep what the turn just answered.
				...(outcome.turn
					? [
							...turnBlocks(rowsOf(outcome.turn)),
							...(outcome.turn.proposals.length ? proposalBlocks(outcome.turn.proposals) : []),
						]
					: []),
			];

	const blocks: Block[] = [{ type: "header", text: "AI Helper" }, ...alerts, ...body];
	return outcome.toast
		? { blocks, toast: { type: "success", message: outcome.toast } }
		: { blocks };
}

/** The dashboard widget: the allowance, and the way to the page. */
export function helperWidget(overview: Answer): BlockResponse {
	if (!("data" in overview)) return { blocks: [answerBanner(overview, UNAVAILABLE), OPEN_PAGE] };
	const o = overviewOf(overview.data);
	return {
		blocks: [
			...allowanceBlocks(o.allowance),
			...(o.enabled ? [] : [{ type: "context" as const, text: "The AI Helper is off." }]),
			OPEN_PAGE,
		],
	};
}
