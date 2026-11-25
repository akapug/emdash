/**
 * Fork-side render & wiring arm for @emdash-cms/plugin-design (emb/27).
 *
 * Drives the REAL EmDashRuntime, real SQLite plugin KV, real HookPipeline,
 * real renderFragments("head") (the exact renderer <EmDashHead> calls), and
 * real dispatchPluginApiRequest auth boundary.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
	computeFingerprint,
	createPlugin,
	designPlugin,
} from "../../../../plugins/design/src/index.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { renderFragments } from "../../../src/page/fragments.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import type { PublicPageContext } from "../../../src/plugins/types.js";

const runtimes: EmDashRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

async function createDesignRuntime() {
	const sqlite = new Database(":memory:");
	const runtime = await EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [createPlugin()],
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
	runtimes.push(runtime);
	return { runtime, sqlite };
}

function pageAt(path: string): PublicPageContext {
	return {
		path,
		url: `https://acme.example${path}`,
		title: "Acme",
		kind: "page",
	} as unknown as PublicPageContext;
}

const ADMIN_USER = {
	id: "usr_admin",
	email: "owner@acme.example",
	name: "Owner",
	role: 50,
	createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("emb/27: @emdash-cms/plugin-design real EmDash render & tenant wiring", () => {
	it("emits one <style data-embark-design> in <head> when rules exist, none when empty, and strips hostile KV rows at compile time", async () => {
		const { runtime, sqlite } = await createDesignRuntime();

		// 1. No rules -> <head> has no <style data-embark-design>
		const emptyFrags = await runtime.collectPageFragments(pageAt("/about"));
		expect(renderFragments(emptyFrags, "head")).toBe("");

		// 2. Unauthenticated visitor cannot call any design plugin route
		const anonRes = await dispatchPluginApiRequest({
			runtime,
			pluginId: "design",
			path: "/rules/upsert",
			request: new Request("https://acme.example/_emdash/api/plugins/design/rules/upsert", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					selector: "#hero-title",
					declarations: { color: "#c25a1a" },
					fingerprint: computeFingerprint("h1", "About Us"),
				}),
			}),
			user: null,
		});
		expect(anonRes.status).toBe(401);

		// 3. Authenticated admin saves a rule via real plugin API route -> stored in real SQLite KV
		const adminRes = await dispatchPluginApiRequest({
			runtime,
			pluginId: "design",
			path: "/rules/upsert",
			request: new Request("https://acme.example/_emdash/api/plugins/design/rules/upsert", {
				method: "POST",
				headers: { "content-type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({
					selector: "#hero-title",
					declarations: { color: "#c25a1a", "font-weight": "700" },
					fingerprint: computeFingerprint("h1", "About Us"),
					pagePath: "/about",
					updatedBy: "owner",
				}),
			}),
			user: ADMIN_USER as never,
		});
		expect(adminRes.status).toBe(200);

		// 4. Real page render on /about emits exactly ONE <style data-embark-design> in <head>
		const aboutFrags = await runtime.collectPageFragments(pageAt("/about"));
		const aboutHead = renderFragments(aboutFrags, "head");
		const styleMatches = aboutHead.match(/<style data-embark-design>/g) ?? [];
		expect(styleMatches).toHaveLength(1);
		expect(aboutHead).toBe(
			"<style data-embark-design>#hero-title { color: #c25a1a; font-weight: 700; }</style>",
		);

		// Different page path omits the /about-scoped rule
		const contactFrags = await runtime.collectPageFragments(pageAt("/contact"));
		expect(renderFragments(contactFrags, "head")).toBe("");

		// 5. Hostile KV row written directly to SQLite is re-validated out at compile time
		const hostileRules = [
			{
				id: "poison_1",
				selector: "</style><script>alert(1)</script>",
				declarations: { color: "red" },
				fingerprint: computeFingerprint("h1", "About Us"),
				status: "active",
				updatedBy: "attacker",
				at: new Date().toISOString(),
			},
			{
				id: "poison_2",
				selector: "#hero-title",
				declarations: { "background-image": 'url("https://evil.example/leak.png")' },
				fingerprint: computeFingerprint("h1", "About Us"),
				status: "active",
				updatedBy: "attacker",
				at: new Date().toISOString(),
			},
		];
		const poisoned = sqlite
			.prepare("UPDATE options SET value = ? WHERE name = 'plugin:design:design:rules'")
			.run(JSON.stringify(hostileRules));
		expect(poisoned.changes).toBe(1);

		const hostileFrags = await runtime.collectPageFragments(pageAt("/about"));
		const hostileHead = renderFragments(hostileFrags, "head");
		expect(hostileHead).toBe("");
		expect(hostileHead).not.toContain("<script");
		expect(hostileHead).not.toContain("evil.example");
	});

	it("wires @emdash-cms/plugin-design into the blog-cloudflare tenant composite with admin-only Design page", () => {
		const desc = designPlugin();
		expect(desc.adminPages).toEqual([{ path: "/design", label: "Design", icon: "paint-brush" }]);

		const root = resolve(import.meta.dirname, "../../../../..");
		const astroConfig = readFileSync(
			resolve(root, "templates/blog-cloudflare/astro.config.mjs"),
			"utf8",
		);
		const pkgJson = JSON.parse(
			readFileSync(resolve(root, "templates/blog-cloudflare/package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
		};

		expect(pkgJson.dependencies?.["@emdash-cms/plugin-design"]).toBe("workspace:*");
		expect(astroConfig).toContain('import { designPlugin } from "@emdash-cms/plugin-design"');
		expect(astroConfig).toContain("designPlugin()");
	});
});
