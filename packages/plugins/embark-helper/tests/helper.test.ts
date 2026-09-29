import { readdirSync, readFileSync } from "node:fs";

import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import type { RouteContext } from "emdash";
import { describe, expect, it, vi } from "vitest";

import { createPlugin, embarkHelperPlugin } from "../src/index.js";

const person = (role: number, email = `role${role}@example.com`) => ({
	id: `user-${role}`,
	email,
	name: null,
	role,
	createdAt: "2026-01-01T00:00:00.000Z",
});
const EDITOR = person(40, "editor@example.com");
const ADMIN = person(50, "admin@example.org");
const AUTHOR = person(30);

const OVERVIEW = {
	enabled: true,
	allowance: {
		usedCents: 25,
		limitCents: 150,
		resetsOn: "2026-10-01",
		plan: "Basic",
		earlyAdopter: false,
	},
	turns: [
		{
			id: "t1",
			role: "user",
			text: "Fix the typo on the About page",
			at: "2026-09-29T10:00:00.000Z",
		},
		{ id: "t2", role: "assistant", text: "I found one typo and drafted a fix.", at: 1790157660000 },
	],
	proposals: [
		{
			id: "p1",
			kind: "text_change",
			summary: "About: change “teh team” to “the team”",
			preview: "…meet the team behind the site…",
		},
	],
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = () => Response | Promise<Response>;

interface Call {
	op: string;
	url: string;
	method: string;
	headers: Headers;
	body: unknown;
	signal: unknown;
}

/**
 * A site with the plugin: its KV rows, the signed-in user, and Embark's answers per op.
 * The KV keeps rows as JSON, as the options table does; `compareAndSet` with a
 * null revision creates a row only when it is absent.
 */
function site(
	options: {
		key?: unknown;
		user?: ReturnType<typeof person> | undefined;
		answers?: Record<string, Answer>;
		http?: boolean;
		kvThrows?: boolean;
		claimThrows?: boolean;
		rows?: Record<string, unknown>;
	} = {},
) {
	const {
		key = "link-key-example",
		answers = {},
		http = true,
		kvThrows = false,
		claimThrows = false,
	} = options;
	const user = "user" in options ? options.user : EDITOR;
	const calls: Call[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
		const op = url.slice(url.lastIndexOf("/") + 1);
		calls.push({
			op,
			url,
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: JSON.parse(init.body as string),
			signal: init.signal,
		});
		return (answers[op] ?? (() => json(OVERVIEW)))();
	});
	const warn = vi.fn();
	const rows = new Map(
		Object.entries(options.rows ?? {}).map(([name, v]) => [name, JSON.stringify(v)]),
	);
	const kv = {
		get: async (name: string) => {
			if (kvThrows) throw new Error("unreadable row");
			if (name === "linkKey") return key;
			const v = rows.get(name);
			return v === undefined ? null : JSON.parse(v);
		},
		compareAndSet: async (name: string, revision: string | null, v: unknown) => {
			if (claimThrows) throw new Error("the options table is locked");
			if (revision !== null || rows.has(name)) return { applied: false };
			rows.set(name, JSON.stringify(v));
			return { applied: true, revision: `rev-${rows.size}` };
		},
		set: async (name: string, v: unknown) => {
			rows.set(name, JSON.stringify(v));
		},
		delete: async (name: string) => rows.delete(name),
		list: async (prefix = "") =>
			[...rows]
				.filter(([name]) => name.startsWith(prefix))
				.map(([name, v]) => ({ key: name, value: JSON.parse(v) })),
	};
	const handle = (input: unknown) =>
		createPlugin().routes.admin!.handler({
			input,
			user,
			kv,
			...(http ? { http: { fetch } } : {}),
			log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
		} as unknown as RouteContext) as Promise<BlockResponse>;
	return { calls, fetch, warn, handle, rows };
}

const PAGE = { type: "page_load", page: "/" };
const WIDGET = { type: "page_load", page: "widget:allowance" };
const ASK_FORM_ID = /^ask:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
/** A submit of one rendered ask form: its block id carries that form's nonce. */
const ask = (message: unknown, nonce: string = crypto.randomUUID()) => ({
	type: "form_submit",
	action_id: "ask",
	block_id: `ask:${nonce}`,
	values: { message },
	page: "/",
});
const press = (action_id: string, value: unknown) => ({
	type: "block_action",
	action_id,
	value,
	page: "/",
});

const ofType = <T extends Block["type"]>(res: BlockResponse, type: T) =>
	res.blocks.filter((b): b is Extract<Block, { type: T }> => b.type === type);
const text = (res: BlockResponse) => JSON.stringify(res.blocks);

/** Every answer is Block Kit the admin can render: the real validator, with the plugin's own page declared. */
function expectValid(res: BlockResponse) {
	const result = validateBlockResponse(res, { pluginPagePaths: ["/"] });
	expect(result.errors).toEqual([]);
	expect(res.blocks.length).toBeGreaterThan(0);
}

describe("the plugin's declaration", () => {
	it("reaches only embarkeasy.com, and declares its page and widget", () => {
		const d = embarkHelperPlugin();
		expect(d).toMatchObject({
			id: "embark-helper",
			entrypoint: "@emdash-cms/plugin-embark-helper",
			capabilities: ["network:request"],
			allowedHosts: ["embarkeasy.com"],
			adminPages: [{ path: "/", label: "AI Helper" }],
			adminWidgets: [{ id: "allowance", title: "AI Helper" }],
		});
		const p = createPlugin();
		expect(p.id).toBe(d.id);
		expect(p.version).toBe(d.version);
		expect(p.capabilities).toEqual(["network:request"]);
		expect(p.allowedHosts).toEqual(["embarkeasy.com"]);
		expect(p.admin.pages).toEqual(d.adminPages);
		expect(p.admin.widgets).toEqual(d.adminWidgets);
		expect(Object.keys(p.routes)).toEqual(["admin"]);
		expect(p.storage).toEqual({});
	});

	it("lets editors and administrators reach the route, and no one below", () => {
		// content:publish_any is the editor role's permission: approving a proposal publishes it.
		expect(createPlugin().routes.admin!.permission).toBe("content:publish_any");
	});
});

describe("a site Embark has not linked", () => {
	for (const [label, key] of [
		["no link key", null],
		["a blank link key", "   "],
		["a link key that is not text", 42],
	] as const) {
		it(`with ${label}, says one plain sentence and asks Embark nothing`, async () => {
			const s = site({ key });
			for (const input of [PAGE, WIDGET, ask("hello"), press("approve", "p1")]) {
				const res = await s.handle(input);
				expect(res).toEqual({
					blocks: [{ type: "section", text: "The AI Helper comes with Embark hosting." }],
				});
			}
			expect(s.fetch).not.toHaveBeenCalled();
		});
	}

	it("says so readably when the link key row cannot be read, and asks Embark nothing", async () => {
		const s = site({ kvThrows: true });
		const res = await s.handle(PAGE);
		expectValid(res);
		expect(ofType(res, "banner")[0]).toMatchObject({ variant: "error" });
		expect(s.fetch).not.toHaveBeenCalled();
	});
});

describe("who may use it", () => {
	for (const [label, user] of [
		["an author", AUTHOR],
		["a request with no signed-in user", undefined],
	] as const) {
		it(`refuses ${label} in words, and asks Embark nothing`, async () => {
			const s = site({ user });
			for (const input of [PAGE, WIDGET, ask("hello")]) {
				const res = await s.handle(input);
				expect(res).toEqual({
					blocks: [
						{
							type: "section",
							text: "The AI Helper is for this site's editors and administrators.",
						},
					],
				});
			}
			expect(s.fetch).not.toHaveBeenCalled();
		});
	}
});

describe("the request to Embark", () => {
	it("posts the op to the control plane with the link key and the signed-in user", async () => {
		const s = site();
		await s.handle(PAGE);
		expect(s.calls).toHaveLength(1);
		const [c] = s.calls;
		expect(c.url).toBe("https://embarkeasy.com/api/tenant-helper/overview");
		expect(c.method).toBe("POST");
		expect(c.headers.get("authorization")).toBe("Bearer link-key-example");
		expect(c.headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(c.headers.get("x-embark-user")!)).toEqual({
			id: "user-40",
			email: "editor@example.com",
			role: "editor",
		});
		expect(c.body).toEqual({});
		expect(c.signal).toBeInstanceOf(AbortSignal);
	});

	it("sends the key without the spaces around it", async () => {
		const s = site({ key: "  link-key-example\n" });
		await s.handle(PAGE);
		expect(s.calls[0].headers.get("authorization")).toBe("Bearer link-key-example");
	});

	it("keeps a user header with a non-ASCII address sendable, and it reads back the same", async () => {
		const user = person(50, "rené@example.org");
		const s = site({ user });
		await s.handle(PAGE);
		const header = s.calls[0].headers.get("x-embark-user")!;
		expect(header).toMatch(/^[\x20-\x7e]+$/);
		expect(JSON.parse(header)).toEqual({ id: "user-50", email: "rené@example.org", role: "admin" });
	});

	it("escapes a user past the Basic Multilingual Plane too, and it reads back the same", async () => {
		const user = person(50, "\u{1F600}@example.org");
		const s = site({ user });
		await s.handle(PAGE);
		const header = s.calls[0].headers.get("x-embark-user")!;
		expect(header).toMatch(/^[\x20-\x7e]+$/);
		expect(JSON.parse(header).email).toBe("\u{1F600}@example.org");
	});
});

describe("the plugin's source", () => {
	it("spells every character a reader cannot see as an escape", () => {
		// Noncharacters (U+FDD0..U+FDEF, U+xFFFE, U+xFFFF) are invisible in editors and diffs.
		const invisible = /[\uFDD0-\uFDEF\uFFFE\uFFFF]/u;
		const dir = new URL("../src/", import.meta.url);
		const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const lines = readFileSync(new URL(f, dir), "utf8").split("\n");
			const found = lines.flatMap((l, n) => (invisible.test(l) ? [`${f}:${n + 1}`] : []));
			expect(found).toEqual([]);
		}
	});
});

describe("the AI Helper page", () => {
	it("shows the allowance, the ask box, the last turns and the proposals", async () => {
		const res = await site().handle(PAGE);
		expectValid(res);
		expect(ofType(res, "header")[0]!.text).toBe("AI Helper");

		const [meter] = ofType(res, "meter");
		expect(meter).toMatchObject({ value: 16, max: 100, custom_value: "16% used" });
		expect(text(res)).toContain("Basic plan");
		expect(text(res)).toContain("Resets Oct 1");
		expect(text(res)).not.toContain("Cents");

		const [form] = ofType(res, "form");
		expect(form).toMatchObject({
			block_id: expect.stringMatching(ASK_FORM_ID),
			submit: { action_id: "ask" },
		});
		expect(form!.fields[0]).toMatchObject({ type: "text_input", action_id: "message" });

		const all = text(res);
		expect(all.indexOf("Fix the typo on the About page")).toBeGreaterThan(-1);
		expect(all.indexOf("I found one typo and drafted a fix.")).toBeGreaterThan(
			all.indexOf("Fix the typo on the About page"),
		);
		expect(all).toContain("About: change “teh team” to “the team”");
		expect(all).toContain("…meet the team behind the site…");

		const buttons = ofType(res, "actions").flatMap((a) => a.elements);
		expect(buttons).toContainEqual(
			expect.objectContaining({ type: "button", action_id: "approve", value: "p1" }),
		);
		expect(buttons).toContainEqual(
			expect.objectContaining({ type: "button", action_id: "reject", value: "p1" }),
		);
		expect(buttons.find((b) => "action_id" in b && b.action_id === "approve")).toHaveProperty(
			"confirm",
		);
	});

	it("shows the switch to an administrator, and only the state to an editor", async () => {
		const adminPage = await site({ user: ADMIN }).handle(PAGE);
		expectValid(adminPage);
		const toggles = ofType(adminPage, "actions")
			.flatMap((a) => a.elements)
			.filter((e) => e.type === "toggle");
		expect(toggles).toEqual([
			expect.objectContaining({ action_id: "toggle", initial_value: true }),
		]);

		const editorPage = await site().handle(PAGE);
		expect(text(editorPage)).not.toContain('"toggle"');
		expect(text(editorPage)).toContain("An administrator can turn it off.");
	});

	it("while the Helper is off, says so and offers no ask box", async () => {
		const off = () => json({ ...OVERVIEW, enabled: false });
		const res = await site({ answers: { overview: off } }).handle(PAGE);
		expectValid(res);
		expect(ofType(res, "form")).toEqual([]);
		expect(ofType(res, "banner")[0]).toMatchObject({ title: "The AI Helper is off" });
	});

	it("says plainly when there is nothing yet", async () => {
		const empty = () => json({ ...OVERVIEW, turns: [], proposals: [] });
		const res = await site({ answers: { overview: empty } }).handle(PAGE);
		expectValid(res);
		expect(text(res)).toContain("Nothing asked yet.");
		expect(text(res)).toContain("Nothing is waiting for approval.");
	});

	it("shows only the user's and the Helper's rows of the conversation", async () => {
		const turns = [
			{ id: "t1", role: "system", text: "You are the site's AI Helper.", at: null },
			{ id: "t2", role: "user", text: "What is on the home page?", at: null },
			{ id: "t3", role: "tool", text: '{"page":"home"}', at: null },
			{ id: "t4", text: "A row with no role.", at: null },
			{ id: "t5", role: "assistant", text: "A welcome and three posts.", at: null },
		];
		const res = await site({ answers: { overview: () => json({ ...OVERVIEW, turns }) } }).handle(
			PAGE,
		);
		expectValid(res);
		const sections = ofType(res, "section").map((b) => b.text);
		expect(sections).toContain("What is on the home page?");
		expect(sections).toContain("A welcome and three posts.");
		for (const hidden of ["You are the site's AI Helper.", '{"page":"home"}', "A row with no role."])
			expect(sections).not.toContain(hidden);
		const labels = ofType(res, "context").map((b) => b.text);
		expect(labels).toEqual(expect.arrayContaining(["Asked", "AI Helper"]));
		for (const label of ["System", "Tool", "Note"]) expect(labels).not.toContain(label);
	});

	it("shows at most the last ten turns", async () => {
		const turns = Array.from({ length: 14 }, (_, n) => ({
			id: `t${n}`,
			role: n % 2 ? "assistant" : "user",
			text: `turn number ${n}.`,
			at: null,
		}));
		const res = await site({ answers: { overview: () => json({ ...OVERVIEW, turns }) } }).handle(
			PAGE,
		);
		expect(text(res)).not.toContain("turn number 3.");
		expect(text(res)).toContain("turn number 4.");
		expect(text(res)).toContain("turn number 13.");
	});
});

describe("asking", () => {
	it("sends the message, then shows the page again with the reply", async () => {
		const s = site({
			answers: {
				turn: () => json({ reply: "I found one typo and drafted a fix.", proposals: [] }),
			},
		});
		const res = await s.handle(ask("  Fix the typo on the About page "));
		expect(s.calls.map((c) => c.op)).toEqual(["turn", "overview"]);
		expect(s.calls[0].body).toEqual({ message: "Fix the typo on the About page" });
		expectValid(res);
		expect(text(res).split("I found one typo and drafted a fix.")).toHaveLength(2);
	});

	it("shows the reply and its proposals even when the overview has not caught up", async () => {
		const s = site({
			answers: {
				turn: () =>
					json({
						reply: "Drafted a new title.",
						proposals: [{ id: "p9", kind: "title_change", summary: "New title", preview: "" }],
					}),
			},
		});
		const res = await s.handle(ask("Shorten the title"));
		expectValid(res);
		expect(text(res)).toContain("Shorten the title");
		expect(text(res)).toContain("Drafted a new title.");
		const buttons = ofType(res, "actions").flatMap((a) => a.elements);
		expect(buttons).toContainEqual(expect.objectContaining({ action_id: "approve", value: "p9" }));
	});

	const blankSections = (res: BlockResponse) =>
		ofType(res, "section").filter((b) => b.text.trim() === "");
	const labels = (res: BlockResponse) => ofType(res, "context").map((b) => b.text);

	it("shows a blank reply that drafted changes as a count of them, never an empty bubble", async () => {
		const p = (id: string) => ({ id, kind: "text_change", summary: `Change ${id}`, preview: "" });
		for (const [proposals, words] of [
			[[p("p8")], "Drafted 1 change for your approval below."],
			[[p("p8"), p("p9")], "Drafted 2 changes for your approval below."],
		] as const) {
			for (const overview of [() => json(OVERVIEW), () => new Response("", { status: 503 })]) {
				const s = site({ answers: { turn: () => json({ reply: "", proposals }), overview } });
				const res = await s.handle(ask("Retitle the About page"));
				expectValid(res);
				expect(blankSections(res)).toEqual([]);
				expect(ofType(res, "section").map((b) => b.text)).toContain(words);
			}
		}
	});

	it("leaves out a blank reply that drafted nothing", async () => {
		const s = site({
			answers: {
				turn: () => json({ reply: "  \n ", proposals: [] }),
				overview: () => json({ ...OVERVIEW, turns: [] }),
			},
		});
		const res = await s.handle(ask("Retitle the About page"));
		expectValid(res);
		expect(blankSections(res)).toEqual([]);
		expect(labels(res)).toContain("Asked");
		expect(labels(res)).not.toContain("AI Helper");
		expect(text(res)).toContain("Retitle the About page");
	});

	it("does not repeat a question the overview already has when its reply was blank", async () => {
		const turns = [
			...OVERVIEW.turns,
			{ id: "t3", role: "user", text: "Retitle the About page", at: null },
			{ id: "t4", role: "assistant", text: "", at: null },
		];
		const s = site({
			answers: {
				turn: () => json({ reply: "", proposals: [] }),
				overview: () => json({ ...OVERVIEW, turns }),
			},
		});
		const res = await s.handle(ask("Retitle the About page"));
		expect(text(res).split("Retitle the About page")).toHaveLength(2);
	});

	it("gives each line of a reply its own block, so a list keeps its lines", async () => {
		const reply = "Here are the steps:\n1. Open the About page.\n\n2. Fix the typo.\r\n3. Save it.";
		const s = site({ answers: { turn: () => json({ reply, proposals: [] }) } });
		const res = await s.handle(ask("How do I fix it?"));
		expectValid(res);
		const sections = ofType(res, "section").map((b) => b.text);
		const at = sections.indexOf("Here are the steps:");
		expect(at).toBeGreaterThan(-1);
		expect(sections.slice(at, at + 4)).toEqual([
			"Here are the steps:",
			"1. Open the About page.",
			"2. Fix the typo.",
			"3. Save it.",
		]);
		expect(sections.filter((t) => /[\r\n]/.test(t))).toEqual([]);
	});

	it("shows a refusal's message verbatim", async () => {
		const message = "You have used this month's Helper allowance. It resets on Oct 1.";
		const s = site({
			answers: { turn: () => json({ refused: { reason: "helper_allowance_used", message } }) },
		});
		const res = await s.handle(ask("One more thing"));
		expectValid(res);
		const banners = ofType(res, "banner").filter((b) => b.variant === "alert");
		expect(banners.map((b) => b.description)).toEqual([message]);
	});

	it("shows a refusal verbatim even when it comes with a non-2xx status", async () => {
		const message = "The Helper is off for this site.";
		const s = site({
			answers: { turn: () => json({ refused: { reason: "helper_off", message } }, 403) },
		});
		const res = await s.handle(ask("Hello"));
		expect(ofType(res, "banner").map((b) => b.description)).toContain(message);
	});

	it("names the reason when a refusal carries no message", async () => {
		const s = site({ answers: { turn: () => json({ refused: { reason: "helper_no_plan" } }) } });
		const res = await s.handle(ask("Hello"));
		expectValid(res);
		expect(text(res)).toContain("helper_no_plan");
	});

	it("sends nothing for an empty message, and says what to do", async () => {
		const s = site();
		const res = await s.handle(ask("   "));
		expect(s.calls.map((c) => c.op)).toEqual(["overview"]);
		expectValid(res);
		expect(ofType(res, "banner")[0]).toMatchObject({ variant: "alert" });
	});
});

describe("when Embark refuses the overview", () => {
	const refusal = (reason: string, message: string) => () =>
		json({ refused: { reason, message } }, 403);
	const toggles = (res: BlockResponse) =>
		ofType(res, "actions")
			.flatMap((a) => a.elements)
			.filter((e) => e.type === "toggle");

	it("titles its banner as not available on the page and the widget, since nobody asked anything", async () => {
		const message = "This site's plan does not include the AI Helper.";
		const s = site({ answers: { overview: refusal("helper_no_plan", message) } });
		for (const input of [PAGE, WIDGET]) {
			const res = await s.handle(input);
			expectValid(res);
			expect(ofType(res, "banner")[0]).toMatchObject({
				variant: "alert",
				title: "The AI Helper is not available",
				description: message,
			});
			expect(text(res)).not.toContain("did not do that");
		}
	});

	it("keeps the did-not-do-that title for a refused request", async () => {
		const s = site({
			answers: { turn: () => json({ refused: { reason: "helper_off", message: "Off." } }) },
		});
		const res = await s.handle(ask("Hello"));
		expect(ofType(res, "banner")[0]).toMatchObject({ title: "The AI Helper did not do that" });
	});

	it("keeps the switch for an administrator while the Helper is off, so it can be turned back on", async () => {
		const message = "The AI Helper is off for this site.";
		const res = await site({
			user: ADMIN,
			answers: { overview: refusal("helper_off", message) },
		}).handle(PAGE);
		expectValid(res);
		expect(ofType(res, "banner").map((b) => b.description)).toContain(message);
		expect(toggles(res)).toEqual([
			expect.objectContaining({ action_id: "toggle", initial_value: false }),
		]);
	});

	it("shows no switch to an editor, nor to an administrator refused for another reason", async () => {
		const off = refusal("helper_off", "Off.");
		const noPlan = refusal("helper_no_plan", "No plan.");
		for (const [user, overview] of [
			[EDITOR, off],
			[ADMIN, noPlan],
		] as const) {
			const res = await site({ user, answers: { overview } }).handle(PAGE);
			expectValid(res);
			expect(toggles(res)).toEqual([]);
		}
	});
});

describe("pressing Ask twice", () => {
	/** Embark's answer to a turn, held until the test lets it go. */
	function heldTurn(reply: unknown) {
		let release = () => {};
		const held = new Promise<void>((done) => {
			release = done;
		});
		const answer = async () => {
			await held;
			return json(reply);
		};
		return { answer, release };
	}
	const turns = (s: ReturnType<typeof site>) => s.calls.filter((c) => c.op === "turn");
	/** Only the clock the wait reads and sleeps on; Response bodies keep their own scheduling. */
	const FAKE: Array<"setTimeout" | "clearTimeout" | "Date"> = ["setTimeout", "clearTimeout", "Date"];

	it("renders a fresh ask form each time, so a sent question leaves an empty box", async () => {
		const s = site();
		const idOf = async () => ofType(await s.handle(PAGE), "form")[0]!.block_id;
		const [a, b] = [await idOf(), await idOf()];
		expect(a).toMatch(ASK_FORM_ID);
		expect(b).toMatch(ASK_FORM_ID);
		expect(a).not.toBe(b);
	});

	it("runs one turn for two submits of the same form, and both show its reply", async () => {
		vi.useFakeTimers({ toFake: FAKE });
		try {
			const t = heldTurn({
				reply: "I drafted the fix.",
				proposals: [{ id: "p7", kind: "text_change", summary: "Fix it", preview: "" }],
			});
			const s = site({ answers: { turn: t.answer } });
			const form = ask("Fix the typo");
			const pages = [s.handle(form), s.handle(form)];
			await vi.advanceTimersByTimeAsync(5_000);
			expect(turns(s)).toHaveLength(1);
			t.release();
			await vi.advanceTimersByTimeAsync(2_000);
			for (const res of await Promise.all(pages)) {
				expectValid(res);
				expect(text(res)).toContain("I drafted the fix.");
				const buttons = ofType(res, "actions").flatMap((a) => a.elements);
				expect(buttons).toContainEqual(
					expect.objectContaining({ action_id: "approve", value: "p7" }),
				);
			}
			expect(turns(s)).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("says the question is being answered, and runs no second turn, while the first outlasts the wait", async () => {
		vi.useFakeTimers({ toFake: FAKE });
		try {
			const t = heldTurn({ reply: "Late.", proposals: [] });
			const s = site({ answers: { turn: t.answer } });
			const form = ask("Rewrite the home page");
			const first = s.handle(form);
			const second = s.handle(form);
			await vi.advanceTimersByTimeAsync(120_000);
			const res = await second;
			expectValid(res);
			expect(ofType(res, "banner").map((b) => b.description)).toContain(
				"That question is already being answered. Reload this page in a minute to see the reply.",
			);
			expect(text(res)).not.toContain("Late.");
			t.release();
			await vi.advanceTimersByTimeAsync(1_000);
			await first;
			expect(turns(s)).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends nothing from a form without its nonce, and says to ask again", async () => {
		const s = site();
		for (const block_id of ["ask", "ask:", "ask:not-a-nonce", undefined]) {
			const res = await s.handle({ ...ask("Hello"), block_id });
			expectValid(res);
			expect(ofType(res, "banner")[0]).toMatchObject({
				variant: "alert",
				description: "This page was out of date, so the question was not sent. Ask it again.",
			});
		}
		expect(turns(s)).toEqual([]);
	});

	it("runs no turn when the question cannot be claimed, and says so readably", async () => {
		const s = site({ claimThrows: true });
		const res = await s.handle(ask("Hello"));
		expect(s.calls.map((c) => c.op)).toEqual(["overview"]);
		expectValid(res);
		expect(ofType(res, "banner")[0]).toMatchObject({ variant: "error" });
	});

	it("records the turn's outcome on its claim, and clears claims older than a day", async () => {
		const now = Date.now();
		const s = site({
			rows: {
				"turn:old": { at: now - 2 * DAY_MS },
				"turn:unreadable": "not a claim",
				"turn:recent": { at: now - 60_000 },
			},
			answers: { turn: () => json({ reply: "Done.", proposals: [] }) },
		});
		const nonce = crypto.randomUUID();
		await s.handle(ask("Hello", nonce));
		expect([...s.rows.keys()].sort()).toEqual(["turn:recent", `turn:${nonce}`].sort());
		expect(JSON.parse(s.rows.get(`turn:${nonce}`)!)).toMatchObject({
			outcome: { turn: { message: "Hello", reply: "Done." } },
		});
	});
});

describe("proposals", () => {
	it("approves one by its id", async () => {
		const s = site({ answers: { approve: () => json({ ok: true }) } });
		const res = await s.handle(press("approve", "p1"));
		expect(s.calls.map((c) => c.op)).toEqual(["approve", "overview"]);
		expect(s.calls[0].body).toEqual({ proposalId: "p1" });
		expectValid(res);
		expect(res.toast).toEqual({ type: "success", message: "Approved" });
	});

	it("shows a refused approval's message verbatim", async () => {
		const message = "Someone edited this page after the Helper drafted the change.";
		const s = site({
			answers: { approve: () => json({ refused: { reason: "stale_draft", message } }) },
		});
		const res = await s.handle(press("approve", "p1"));
		expect(ofType(res, "banner").map((b) => b.description)).toContain(message);
		expect(res.toast).toBeUndefined();
	});

	it("discards one by its id", async () => {
		const s = site({ answers: { reject: () => json({ ok: true }) } });
		const res = await s.handle(press("reject", "p1"));
		expect(s.calls.map((c) => c.op)).toEqual(["reject", "overview"]);
		expect(s.calls[0].body).toEqual({ proposalId: "p1" });
		expect(res.toast).toEqual({ type: "success", message: "Discarded" });
	});

	for (const [label, body] of [
		["{ ok: false }", { ok: false }],
		["no ok at all", { approved: true }],
	] as const) {
		it(`shows no Approved toast when Embark answers ${label}`, async () => {
			const s = site({ answers: { approve: () => json(body) } });
			const res = await s.handle(press("approve", "p1"));
			expectValid(res);
			expect(res.toast).toBeUndefined();
			expect(ofType(res, "banner")[0]).toMatchObject({
				variant: "error",
				description: "The AI Helper could not read Embark's answer.",
			});
		});
	}

	it("sends nothing for a button without a proposal id", async () => {
		const s = site();
		await s.handle(press("approve", ""));
		expect(s.calls.map((c) => c.op)).toEqual(["overview"]);
	});
});

describe("the on/off switch", () => {
	it("an administrator turns the Helper off", async () => {
		const s = site({ user: ADMIN, answers: { toggle: () => json({ enabled: false }) } });
		const res = await s.handle(press("toggle", false));
		expect(s.calls.map((c) => c.op)).toEqual(["toggle", "overview"]);
		expect(s.calls[0].body).toEqual({ enabled: false });
		expect(res.toast).toEqual({ type: "success", message: "The AI Helper is off" });
	});

	it("an administrator turns it on", async () => {
		const s = site({ user: ADMIN, answers: { toggle: () => json({ enabled: true }) } });
		const res = await s.handle(press("toggle", true));
		expect(s.calls[0].body).toEqual({ enabled: true });
		expect(res.toast).toEqual({ type: "success", message: "The AI Helper is on" });
	});

	it("shows no toast when Embark's answer does not say whether the Helper is on", async () => {
		const s = site({ user: ADMIN, answers: { toggle: () => json({ ok: true }) } });
		const res = await s.handle(press("toggle", true));
		expectValid(res);
		expect(res.toast).toBeUndefined();
		expect(ofType(res, "banner")[0]).toMatchObject({
			variant: "error",
			description: "The AI Helper could not read Embark's answer.",
		});
	});

	it("reports the state Embark confirms, not the one asked for", async () => {
		const s = site({ user: ADMIN, answers: { toggle: () => json({ enabled: false }) } });
		const res = await s.handle(press("toggle", true));
		expect(res.toast).toEqual({ type: "success", message: "The AI Helper is off" });
	});

	it("an editor cannot switch it, and Embark is not asked to", async () => {
		const s = site({ user: EDITOR });
		const res = await s.handle(press("toggle", false));
		expect(s.calls.map((c) => c.op)).toEqual(["overview"]);
		expectValid(res);
		expect(ofType(res, "banner")[0]).toMatchObject({
			variant: "alert",
			description: "Only an administrator can turn the AI Helper on or off.",
		});
	});
});

describe("when Embark cannot answer", () => {
	const RELINK = /Embark did not accept this site's link\. Embark support can relink it\.$/;
	const UNREAD = /could not read Embark's answer\.$/;
	const failures: Array<[string, Answer, RegExp, boolean]> = [
		[
			"a 502",
			() => new Response("bad gateway", { status: 502 }),
			/502\. Try again in a minute\./,
			true,
		],
		["a 429", () => json({ error: "slow down" }, 429), /429\. Try again in a minute\./, true],
		["a 401 with an error body", () => json({ error: "bad link key" }, 401), RELINK, false],
		["a 403 with an error body", () => json({ error: "forbidden" }, 403), RELINK, false],
		["a 404", () => new Response("not found", { status: 404 }), /status 404\.$/, false],
		[
			"a network error",
			() => {
				throw new TypeError("fetch failed");
			},
			/did not go through\. Try again in a minute\./,
			true,
		],
		[
			"a timeout",
			() => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			},
			/in time\. Try again in a minute\./,
			true,
		],
		["a 200 that is not JSON", () => new Response("<html>", { status: 200 }), UNREAD, false],
		["a 200 that is not an object", () => json([1, 2]), UNREAD, false],
	];
	for (const [label, answer, words, retry] of failures) {
		it(`shows a readable banner for ${label}, and offers to try again only where that can help`, async () => {
			const s = site({ answers: { overview: answer } });
			const res = await s.handle(PAGE);
			expectValid(res);
			const [banner] = ofType(res, "banner");
			expect(banner).toMatchObject({ variant: "error" });
			expect(banner!.description).toMatch(words);
			if (!retry) expect(text(res)).not.toMatch(/try again/i);
			const buttons = ofType(res, "actions").flatMap((a) => a.elements);
			expect(buttons.some((b) => "action_id" in b && b.action_id === "reload")).toBe(retry);
		});
	}

	it("says a message is too long when Embark refuses its size, and does not offer to try again", async () => {
		const s = site({ answers: { turn: () => json({ error: "payload too large" }, 413) } });
		const res = await s.handle(ask("A very long request"));
		expectValid(res);
		expect(ofType(res, "banner").map((b) => b.description)).toContain(
			"That message is too long for the AI Helper.",
		);
		expect(text(res)).not.toMatch(/try again/i);
	});

	it("keeps the reply when the page cannot be refreshed after asking", async () => {
		const s = site({
			answers: {
				turn: () => json({ reply: "Here is what I found.", proposals: [] }),
				overview: () => new Response("", { status: 503 }),
			},
		});
		const res = await s.handle(ask("What is on the home page?"));
		expectValid(res);
		expect(text(res)).toContain("Here is what I found.");
		expect(text(res)).toContain("503");
	});

	it("shows a readable banner when an approval fails", async () => {
		const s = site({ answers: { approve: () => new Response("", { status: 500 }) } });
		const res = await s.handle(press("approve", "p1"));
		expectValid(res);
		expect(ofType(res, "banner").map((b) => b.variant)).toContain("error");
		expect(res.toast).toBeUndefined();
	});

	it("shows a readable banner when a turn answers without a reply", async () => {
		const s = site({ answers: { turn: () => json({ proposals: [] }) } });
		const res = await s.handle(ask("Hello"));
		expectValid(res);
		expect(ofType(res, "banner").map((b) => b.variant)).toContain("error");
	});

	it("says so when the site does not let the plugin make requests", async () => {
		const s = site({ http: false });
		const res = await s.handle(PAGE);
		expectValid(res);
		expect(ofType(res, "banner")[0]).toMatchObject({ variant: "error" });
	});
});

describe("the dashboard widget", () => {
	it("shows the allowance and links to the page", async () => {
		const s = site();
		const res = await s.handle(WIDGET);
		expect(s.calls.map((c) => c.op)).toEqual(["overview"]);
		expectValid(res);
		expect(ofType(res, "meter")[0]).toMatchObject({ value: 16, custom_value: "16% used" });
		expect(text(res)).toContain("Resets Oct 1");
		const links = ofType(res, "actions").flatMap((a) => a.elements);
		expect(links).toContainEqual(
			expect.objectContaining({ type: "link", target: { kind: "plugin-page", path: "/" } }),
		);
		expect(ofType(res, "form")).toEqual([]);
	});

	it("says when the Helper is off", async () => {
		const off = () => json({ ...OVERVIEW, enabled: false });
		const res = await site({ answers: { overview: off } }).handle(WIDGET);
		expect(text(res)).toContain("The AI Helper is off.");
	});

	it("shows a readable banner when Embark cannot answer", async () => {
		const res = await site({ answers: { overview: () => json({}, 500) } }).handle(WIDGET);
		expectValid(res);
		expect(ofType(res, "banner")[0]).toMatchObject({ variant: "error" });
	});
});

describe("the allowance meter", () => {
	const at = (usedCents: number, limitCents: number, extra: Record<string, unknown> = {}) =>
		site({
			answers: {
				overview: () =>
					json({
						...OVERVIEW,
						allowance: { ...OVERVIEW.allowance, usedCents, limitCents, ...extra },
					}),
			},
		}).handle(WIDGET);

	it("stops at 100% when the allowance is overspent", async () => {
		expect(ofType(await at(900, 150), "meter")[0]).toMatchObject({ value: 100 });
	});

	it("reads 0% on a fresh month", async () => {
		expect(ofType(await at(0, 150), "meter")[0]).toMatchObject({ value: 0 });
	});

	it("reads 100% on a plan with no allowance that has spent some", async () => {
		expect(ofType(await at(5, 0), "meter")[0]).toMatchObject({ value: 100 });
	});

	it("reads 100% and says so on a plan with no allowance that has spent nothing", async () => {
		const res = await at(0, 0);
		expect(ofType(res, "meter")[0]).toMatchObject({ value: 100, custom_value: "100% used" });
		expect(text(res)).toContain("No Helper allowance on this plan");
	});

	it("reads 100% only once the allowance is used up", async () => {
		expect(ofType(await at(149.4, 150), "meter")[0]).toMatchObject({
			value: 99,
			custom_value: "99% used",
		});
		expect(ofType(await at(150, 150), "meter")[0]).toMatchObject({
			value: 100,
			custom_value: "100% used",
		});
		expect(text(await at(149.4, 150))).not.toContain("No Helper allowance");
	});

	it("marks an early adopter's plan", async () => {
		expect(text(await at(0, 150, { earlyAdopter: true }))).toContain("Early adopter");
	});

	it("shows a reset date it cannot read as it came", async () => {
		expect(text(await at(0, 150, { resetsOn: "next month" }))).toContain("Resets next month");
	});

	it("leaves the meter out when the overview has no allowance", async () => {
		const res = await site({
			answers: { overview: () => json({ ...OVERVIEW, allowance: null }) },
		}).handle(WIDGET);
		expect(ofType(res, "meter")).toEqual([]);
		expectValid(res);
	});
});
