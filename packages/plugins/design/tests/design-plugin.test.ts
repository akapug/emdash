import { describe, expect, it } from "vitest";
import type { PageFragmentEvent, PluginContext } from "emdash";

import {
	buildStableSelector,
	compileDesignCss,
	computeFingerprint,
	createPlugin,
	designPlugin,
	fingerprintsMatch,
	MAX_HISTORY,
	sanitizeCssDeclaration,
	sanitizeSelector,
} from "../src/index.js";

function makeMockCtx(input: unknown = {}): { ctx: PluginContext; store: Map<string, unknown> } {
	const store = new Map<string, unknown>();
	const ctx = {
		plugin: { id: "design", version: "0.1.0" },
		input,
		kv: {
			get: async <T,>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
			set: async (key: string, value: unknown) => {
				store.set(key, value);
			},
			delete: async (key: string) => {
				store.delete(key);
			},
			list: async () => [...store.keys()],
		},
		log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
	} as unknown as PluginContext;
	return { ctx, store };
}

describe("emb/27: @emdash-cms/plugin-design", () => {
	it("sanitizes selectors and blocks style-tag breakout, at-rules, and excessive complexity", () => {
		expect(sanitizeSelector("#hero-title")).toEqual({ ok: true, value: "#hero-title" });
		expect(sanitizeSelector('main > section:nth-of-type(2) > h2:nth-of-type(1)')).toEqual({
			ok: true,
			value: "main > section:nth-of-type(2) > h2:nth-of-type(1)",
		});
		expect(sanitizeSelector('[data-embark-slot="siteTitle"]')).toEqual({
			ok: true,
			value: '[data-embark-slot="siteTitle"]',
		});

		expect(sanitizeSelector("</style><script>alert(1)</script>").ok).toBe(false);
		expect(sanitizeSelector("body { color: red }").ok).toBe(false);
		expect(sanitizeSelector("@import url(https://evil.test)").ok).toBe(false);
		expect(sanitizeSelector("a, b").ok).toBe(false);
		expect(sanitizeSelector("a > b > c > d > e > f > g > h > i").ok).toBe(false);
		expect(sanitizeSelector("a".repeat(201)).ok).toBe(false);
	});

	it("sanitizes CSS declarations: allows visual props, gradients, and same-site media; blocks external url() and XSS", () => {
		expect(sanitizeCssDeclaration("color", "#c25a1a").ok).toBe(true);
		expect(sanitizeCssDeclaration("background", "linear-gradient(135deg, #fff, #faf7f2)").ok).toBe(true);
		expect(sanitizeCssDeclaration("display", "none").ok).toBe(true);
		expect(sanitizeCssDeclaration("background-image", 'url("/_emdash/api/media/hero.webp")').ok).toBe(true);

		expect(sanitizeCssDeclaration("background-image", 'url("https://evil.example/track.png")').ok).toBe(false);
		expect(sanitizeCssDeclaration("background-image", 'url("data:image/svg+xml,<svg/>")').ok).toBe(false);
		expect(sanitizeCssDeclaration("background-image", 'url("/_emdash/api/media/../../etc/passwd")').ok).toBe(false);
		expect(sanitizeCssDeclaration("color", "red; } </style><script>alert(1)</script>").ok).toBe(false);
		expect(sanitizeCssDeclaration("color", "expression(alert(1))").ok).toBe(false);
		expect(sanitizeCssDeclaration("behavior", "url(xss.htc)").ok).toBe(false);
		expect(sanitizeCssDeclaration("content", '"injected"').ok).toBe(false);
	});

	it("builds stable-first selectors (id > slot > landmark + nth-of-type) and detects fingerprint drift", () => {
		expect(
			buildStableSelector([
				{ tag: "h1", id: "hero-heading", nthOfType: 1 },
				{ tag: "main", nthOfType: 1 },
			]),
		).toBe("#hero-heading");

		expect(
			buildStableSelector([
				{ tag: "a", slotAttr: { name: "data-embark-slot", value: "siteTitle" }, nthOfType: 1 },
				{ tag: "header", nthOfType: 1 },
			]),
		).toBe('[data-embark-slot="siteTitle"]');

		expect(
			buildStableSelector([
				{ tag: "p", nthOfType: 2 },
				{ tag: "div", nthOfType: 1 },
				{ tag: "main", nthOfType: 1 },
			]),
		).toBe("main > div:nth-of-type(1) > p:nth-of-type(2)");

		const fp1 = computeFingerprint("h2", "Our Story");
		const fp2 = computeFingerprint("h2", "  Our   Story ");
		const fp3 = computeFingerprint("h2", "Contact Us");
		expect(fingerprintsMatch(fp1, fp2)).toBe(true);
		expect(fingerprintsMatch(fp1, fp3)).toBe(false);
	});

	it("keeps all routes admin-only, emits <style data-embark-design> via page:fragments, skips mismatched rules, and supports bounded undo", async () => {
		const desc = designPlugin();
		expect(desc.id).toBe("design");
		expect(desc.adminPages?.[0]?.path).toBe("/design");

		const plugin = createPlugin({ maxHistory: 3 });
		// Security: no route may be public.
		for (const route of Object.values(plugin.routes ?? {})) {
			expect(route.public).not.toBe(true);
		}

		const { ctx, store } = makeMockCtx();
		const call = async (name: string, input: unknown = {}) => {
			const route = plugin.routes?.[name];
			if (!route) throw new Error(`missing route ${name}`);
			return route.handler({ ...ctx, input } as PluginContext);
		};

		// Empty rules -> page:fragments returns null
		const hook = plugin.hooks?.["page:fragments"];
		const runFragments = async (path: string) => {
			const handler = typeof hook === "function" ? hook : hook?.handler;
			return handler!({ page: { path } } as unknown as PageFragmentEvent, ctx);
		};
		expect(await runFragments("/")).toBeNull();

		// Upsert a valid rule
		const fp = computeFingerprint("h1", "Welcome");
		const up1 = (await call("rules/upsert", {
			selector: "#hero-title",
			declarations: { color: "#112233", "font-weight": "700" },
			fingerprint: fp,
			pagePath: "/about",
			updatedBy: "owner",
		})) as { ok: boolean; rule: { id: string } };
		expect(up1.ok).toBe(true);

		// Scoped to /about: emitted on /about, omitted on /
		const fragAbout = (await runFragments("/about")) as { kind: string; placement: string; html: string };
		expect(fragAbout.kind).toBe("html");
		expect(fragAbout.placement).toBe("head");
		expect(fragAbout.html).toBe("<style data-embark-design>#hero-title { color: #112233; font-weight: 700; }</style>");
		expect(await runFragments("/")).toBeNull();

		// Flag fingerprint mismatch -> rule paused and never emitted
		await call("rules/flag-mismatch", { ids: [up1.rule.id] });
		expect(await runFragments("/about")).toBeNull();

		// Bounded history + undo
		for (let i = 0; i < 5; i++) {
			await call("rules/upsert", {
				selector: `main > p:nth-of-type(${i + 1})`,
				declarations: { opacity: "0.9" },
				fingerprint: computeFingerprint("p", `Paragraph ${i}`),
			});
		}
		const listed = (await call("rules/list")) as { rules: unknown[]; historyCount: number };
		expect(listed.historyCount).toBe(3); // capped at maxHistory=3
		expect(MAX_HISTORY).toBe(25);

		const undone = (await call("rules/undo")) as { restored: boolean; rules: unknown[]; historyCount: number };
		expect(undone.restored).toBe(true);
		expect(undone.historyCount).toBe(2);
		expect(undone.rules.length).toBe(listed.rules.length - 1);

		// Defense-in-depth: even if KV were corrupted directly, compileDesignCss rejects unsafe CSS
		store.set("design:rules", [
			{
				id: "poison",
				selector: "</style><script>alert(1)</script>",
				declarations: { color: "red" },
				fingerprint: fp,
				status: "active",
				updatedBy: "x",
				at: new Date().toISOString(),
			},
		]);
		expect(await runFragments("/")).toBeNull();
		expect(compileDesignCss(store.get("design:rules") as never)).toBe("");
	});
});
