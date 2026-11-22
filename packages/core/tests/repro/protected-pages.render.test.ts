import { pbkdf2Sync } from "node:crypto";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CloudHome from "../../../../templates/blog-cloudflare/src/pages/index.astro";
import CloudPage from "../../../../templates/blog-cloudflare/src/pages/pages/[slug].astro";
import CloudPost from "../../../../templates/blog-cloudflare/src/pages/posts/[slug].astro";
import { GET as cloudFeed } from "../../../../templates/blog-cloudflare/src/pages/rss.xml.js";
import ShellPage from "../../../../templates/blog-cloudflare/src/pages/wp-shell/[...path].astro";
import BlogHome from "../../../../templates/blog/src/pages/index.astro";
import BlogPage from "../../../../templates/blog/src/pages/pages/[slug].astro";
import BlogPost from "../../../../templates/blog/src/pages/posts/[slug].astro";
import { GET as blogFeed } from "../../../../templates/blog/src/pages/rss.xml.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

const state = vi.hoisted(() => ({
	entry: undefined as unknown,
	shell: null as unknown,
	feed: false,
	seo: vi.fn(),
}));
async function reads() {
	const seo =
		await vi.importActual<typeof import("../../src/seo/index.js")>("../../src/seo/index.js");
	const query = await vi.importActual<typeof import("../../src/query.js")>("../../src/query.js");
	return {
		...seo,
		getEditMeta: query.getEditMeta,
		getSeoMeta: (...args: Parameters<typeof seo.getSeoMeta>) => {
			state.seo(...args);
			return seo.getSeoMeta(...args);
		},
		resolveProtectedEntry: async (...args: unknown[]) => {
			const { resolveProtectedEntry } = await import("../../src/content/protected-render.js");
			return resolveProtectedEntry(...(args as Parameters<typeof resolveProtectedEntry>));
		},
		getEmDashEntry: async () => ({ entry: state.entry, cacheHint: {} }),
		getHomepage: async () => ({ entry: state.entry, collection: "pages", cacheHint: {} }),
		getEmDashCollection: async () => ({ entries: state.feed ? [state.entry] : [], cacheHint: {} }),
		getSiteSettings: async () => ({ title: "Synthetic site" }),
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Synthetic site", wpShell: state.shell },
			cacheHint: {},
		}),
		getMenuWithCacheHint: async () => ({ data: null, cacheHint: {} }),
		getPublishedDates: async () => [],
		getTermsForEntries: async () => new Map(),
		getCollectionInfo: async () => ({ commentsEnabled: false }),
		decodeSlug: (slug: string) => decodeURIComponent(slug),
	};
}
vi.mock("emdash", reads);
vi.mock("../../dist/index.mjs", reads);
vi.mock("../../../../templates/blog-cloudflare/src/layouts/Base.astro", async () => ({
	default: (await import("./StubBase.astro")).default,
}));
vi.mock("../../../../templates/blog/src/layouts/Base.astro", async () => ({
	default: (await import("./StubBase.astro")).default,
}));

const SECRET = "SYNTHETIC_ROUTE_BODY_8835";
const EXCERPT = "SYNTHETIC_ROUTE_EXCERPT_8835";
const SEO = "SYNTHETIC_ROUTE_SEO_8835";
const PASSWORD = " yes é ";
const salt = "0102030405060708090a0b0c0d0e0f10";
const shell = {
	version: 1,
	id: "0123456789abcdef01234567",
	source: { url: "https://example.org/", capturedAt: "2026-11-20T00:00:00Z" },
	html: { lang: "en", class: "" },
	body: { class: "page" },
	styles: [],
	menus: [],
	parts: [
		{ html: '<main id="source-shell">' },
		{ slot: "title", tag: "h1" },
		{ slot: "content", tag: "div", class: "entry-content" },
		{ html: "</main>" },
	],
};

describe("ordinary protected page routes", () => {
	let db: Kysely<Database>;
	let entries: Record<string, unknown>;
	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		entries = {};
		for (const collection of ["pages", "posts"]) {
			await registry.createCollection({ slug: collection, label: collection, hasSeo: true });
			for (const [slug, type] of [
				["title", "string"],
				["content", "portableText"],
				["excerpt", "text"],
			] as const)
				await registry.createField(collection, { slug, label: slug, type });
			const item = await new ContentRepository(db).create({
				type: collection,
				slug: "protected",
				status: "published",
				data: {
					title: "Protected title",
					excerpt: EXCERPT,
					content: [
						{
							_type: "block",
							_key: "one",
							style: "normal",
							markDefs: [],
							children: [{ _type: "span", _key: "text", marks: [], text: SECRET }],
						},
					],
				},
				protection: {
					version: 1,
					mode: "password",
					verifier: {
						version: 1,
						algorithm: "pbkdf2-sha256",
						iterations: 100000,
						salt,
						hash: pbkdf2Sync(PASSWORD, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString(
							"hex",
						),
					},
				},
			});
			await new SeoRepository(db).upsert(collection, item.id, { description: SEO });
			entries[collection] = {
				id: "protected",
				data: {
					...item.data,
					id: item.id,
					status: item.status,
					translationGroup: item.translationGroup,
					updatedAt: new Date(),
					publishedAt: new Date("2026-11-20T00:00:00Z"),
				},
				edit: { title: {}, content: {} },
			};
		}
		state.entry = entries.pages;
		state.shell = null;
		state.feed = false;
		state.seo.mockClear();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function render(
		component: typeof CloudPage,
		password?: string,
		shellRoute = false,
		collection = "pages",
	) {
		state.entry = entries[collection];
		state.shell = shellRoute ? shell : null;
		const container = await AstroContainer.create();
		const request = new Request(
			`https://example.org/${collection}/protected`,
			password === undefined
				? {}
				: {
						method: "POST",
						headers: { origin: "https://example.org" },
						body: new URLSearchParams({ password }),
					},
		);
		return runWithContext({ editMode: false, db }, () =>
			container.renderToResponse(component, {
				request,
				params: shellRoute ? { path: `${collection}/protected` } : { slug: "protected" },
			}),
		);
	}

	for (const [name, feed] of [
		["blog", blogFeed],
		["cloudflare", cloudFeed],
	] as const) {
		it(`${name} RSS uses only the redacted public post projection`, async () => {
			state.entry = entries.posts;
			state.feed = true;
			const response = await feed({
				site: new URL("https://example.org/"),
				url: new URL("https://example.org/rss.xml"),
			} as never);
			const xml = await response.text();
			expect(xml).toContain("<title>Protected title</title>");
			for (const sentinel of [SECRET, EXCERPT, SEO, PASSWORD]) expect(xml).not.toContain(sentinel);
		});
	}

	for (const [name, component, shellRoute, collection] of [
		["blog permalink", BlogPage, false, "pages"],
		["cloudflare permalink", CloudPage, false, "pages"],
		["blog homepage", BlogHome, false, "pages"],
		["cloudflare homepage", CloudHome, false, "pages"],
		["WordPress page shell", ShellPage, true, "pages"],
		["blog post", BlogPost, false, "posts"],
		["cloudflare post", CloudPost, false, "posts"],
		["WordPress post shell", ShellPage, true, "posts"],
	] as const) {
		it(`${name} challenges before SEO and renders only the matching POST, without warming anonymous content`, async () => {
			for (const password of [undefined, "", "wrong", PASSWORD.trim()]) {
				const response = await render(component, password, shellRoute, collection);
				const html = await response.text();
				expect(html).toContain('type="password"');
				for (const sentinel of [SECRET, EXCERPT, SEO, PASSWORD])
					expect(html).not.toContain(sentinel);
				expect(response.headers.get("cache-control")).toBe("private, no-store");
			}
			expect(state.seo).not.toHaveBeenCalled();
			const allowed = await render(component, PASSWORD, shellRoute, collection);
			expect(await allowed.text()).toContain(SECRET);
			expect(allowed.headers.get("cache-control")).toBe("private, no-store");
			expect(state.seo).toHaveBeenCalled();
			const anonymous = await render(component, undefined, shellRoute, collection);
			expect(await anonymous.text()).not.toContain(SECRET);
			expect(JSON.stringify(state.entry)).not.toContain(SECRET);
		});
	}
});
