/**
 * The AI Helper's Block Kit: the admin page and the dashboard widget, built
 * from the control plane's `overview` and whatever the last interaction did.
 */

import type { Block, BlockResponse } from "@emdash-cms/blocks/server";

/** What one call to the control plane came to. */
export type Answer =
	| { data: Record<string, unknown> }
	| { refused: { reason: string; message: string } }
	| { failed: string };

export interface Proposal {
	id: string;
	kind: string;
	summary: string;
	preview: string;
}

interface Turn {
	role: string;
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
	/** A notice the plugin raised itself, before asking Embark anything. */
	banner?: Block;
	/** Embark's refusal, or the failure to reach it. */
	answer?: Exclude<Answer, { data: Record<string, unknown> }>;
	toast?: string;
	turn?: { message: string; reply: string; proposals: Proposal[] };
}

const LAST_TURNS = 10;
const UNDERSCORES = /_+/g;
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

/** A refusal shows the server's message as it came. */
function answerBanner(a: Exclude<Answer, { data: Record<string, unknown> }>): Block {
	return "refused" in a
		? {
				type: "banner",
				variant: "alert",
				title: "The AI Helper did not do that",
				description: a.refused.message,
			}
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

function turnsOf(value: unknown): Turn[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((t) =>
		isRecord(t) && typeof t.text === "string" && t.text.trim() !== ""
			? [{ role: typeof t.role === "string" ? t.role : "", text: t.text, at: t.at }]
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

/** The overview, with the last turn's reply and proposals added if the overview does not have them yet. */
function overviewOf(data: Record<string, unknown>, turn?: Outcome["turn"]) {
	const turns = turnsOf(data.turns);
	const proposals = proposalsOf(data.proposals);
	const caughtUp = !turn || turns.some((t) => t.role === "assistant" && t.text === turn.reply);
	return {
		enabled: data.enabled !== false,
		allowance: allowanceOf(data.allowance),
		turns: (caughtUp
			? turns
			: [
					...turns,
					{ role: "user", text: turn.message, at: null },
					{ role: "assistant", text: turn.reply, at: null },
				]
		).slice(-LAST_TURNS),
		proposals: [
			...proposals,
			...(turn?.proposals ?? []).filter((p) => !proposals.some((q) => q.id === p.id)),
		],
	};
}

/** The allowance, as a share of this month's: never an amount of money. */
function allowanceBlocks(a: Allowance | null): Block[] {
	if (!a) return [];
	const pct =
		a.limitCents > 0
			? Math.min(100, Math.max(0, Math.round((a.usedCents * 100) / a.limitCents)))
			: a.usedCents > 0
				? 100
				: 0;
	const line = [
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
		const who =
			t.role === "user"
				? "Asked"
				: t.role === "assistant"
					? "AI Helper"
					: t.role.charAt(0).toUpperCase() + t.role.slice(1) || "Note";
		const when = whenOf(t.at);
		return [
			{ type: "context", text: when ? `${who} · ${when}` : who },
			{ type: "section", text: t.text },
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

const askForm = (): Block => ({
	type: "form",
	block_id: `${ASK_FORM}${crypto.randomUUID()}`,
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
		...("data" in overview ? [] : [answerBanner(overview)]),
	];
	if (alerts.some((b) => b.type === "banner" && b.variant === "error")) alerts.push(RETRY);

	const o = "data" in overview ? overviewOf(overview.data, outcome.turn) : null;
	const body: Block[] = o
		? [
				...switchBlocks(o.enabled, admin),
				...allowanceBlocks(o.allowance),
				...(o.enabled ? [{ type: "divider" as const }, askForm()] : []),
				{ type: "divider" },
				{ type: "header", text: "Recent conversation" },
				...turnBlocks(o.turns),
				{ type: "divider" },
				{ type: "header", text: "Waiting for approval" },
				...proposalBlocks(o.proposals),
			]
		: // The page could not be refreshed: keep what the turn just answered.
			outcome.turn
			? [
					...turnBlocks([
						{ role: "user", text: outcome.turn.message, at: null },
						{ role: "assistant", text: outcome.turn.reply, at: null },
					]),
					...(outcome.turn.proposals.length ? proposalBlocks(outcome.turn.proposals) : []),
				]
			: [];

	const blocks: Block[] = [{ type: "header", text: "AI Helper" }, ...alerts, ...body];
	return outcome.toast
		? { blocks, toast: { type: "success", message: outcome.toast } }
		: { blocks };
}

/** The dashboard widget: the allowance, and the way to the page. */
export function helperWidget(overview: Answer): BlockResponse {
	if (!("data" in overview)) return { blocks: [answerBanner(overview), OPEN_PAGE] };
	const o = overviewOf(overview.data);
	return {
		blocks: [
			...allowanceBlocks(o.allowance),
			...(o.enabled ? [] : [{ type: "context" as const, text: "The AI Helper is off." }]),
			OPEN_PAGE,
		],
	};
}
