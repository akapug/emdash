/**
 * Synthetic router parity check for `discoverTemplatePublicRoutes` +
 * `resolvePublicContentPaths` against the real `template-blog-cloudflare`
 * Astro route files (`pages/[slug].astro` and `[...date].astro`).
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getEmDashEntryMock } = vi.hoisted(() => ({
	getEmDashEntryMock: vi.fn<() => Promise<{ entry: unknown; cacheHint: undefined }>>(async () => ({
		entry: null,
		cacheHint: undefined,
	})),
}));

vi.mock("emdash", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash")>();
	return {
		...actual,
		getEmDashEntry: getEmDashEntryMock,
		resolveProtectedEntry: async (_astro: unknown, _col: string, entry: unknown) => ({
			entry,
			protected: false,
		}),
		getSiteSettings: async () => ({
			title: "Router Parity Site",
			tagline: "",
			homepage: null,
		}),
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Router Parity Site", tagline: "", homepage: null },
			cacheHint: undefined,
		}),
		getSeoMeta: () => ({
			title: "About Us",
			ogTitle: "About Us",
			description: "",
			canonical: "/pages/about",
			robots: "index, follow",
		}),
	};
});

vi.mock("../../../../templates/blog-cloudflare/src/utils/wp-shell-loader", () => ({
	loadWpShell: async () => ({ shell: null, cacheHint: undefined }),
}));

vi.mock("../../../../templates/blog-cloudflare/src/layouts/Base.astro", async () => {
	const stub = await import("./StubBase.astro");
	return { default: stub.default };
});

import DateArchiveRoute from "../../../../templates/blog-cloudflare/src/pages/[...date].astro";
import PageSlugRoute from "../../../../templates/blog-cloudflare/src/pages/pages/[slug].astro";
import { discoverTemplatePublicRoutes } from "../../src/astro/integration/routes.js";
import { resolvePublicContentPaths, setPublicRoutesConfig } from "../../src/content/public-url.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

describe("Public URL active-template route contract parity (blog-cloudflare)", () => {
	const blogSrcDir = new URL("../../../../templates/blog-cloudflare/src/", import.meta.url);

	beforeEach(() => {
		setPublicRoutesConfig(null);
	});

	afterEach(() => {
		setPublicRoutesConfig(null);
	});

	it("discovers blog-cloudflare collection-owned routes (excluding catch-alls and wp-shell) and matches real route rendering", async () => {
		const routes = discoverTemplatePublicRoutes(blogSrcDir);
		expect(routes).toContainEqual({ pattern: "/", owner: { kind: "homepage" } });
		expect(routes).toContainEqual({
			pattern: "/pages/{slug}",
			owner: { kind: "collection", collection: "pages" },
		});
		expect(routes).toContainEqual({
			pattern: "/posts/{slug}",
			owner: { kind: "collection", collection: "posts" },
		});
		expect(routes).toContainEqual({
			pattern: "/events/{slug}",
			owner: { kind: "uniqueUrlPattern", pattern: "/events/{slug}" },
		});
		expect(routes.some((r) => r.pattern.includes("wp-shell") || r.pattern.includes("date"))).toBe(
			false,
		);

		const db = await setupTestDatabase();
		try {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "pages", label: "Pages" });
			await registry.createCollection({ slug: "articles", label: "Articles" });
			await registry.updateCollection("articles", { urlPattern: "/journal/{slug}" });
			// Same-pattern wrong-owner: custom collection claiming `/pages/{slug}` even
			// though `blog-cloudflare/src/pages/pages/[slug].astro` only reads `pages`.
			await registry.createCollection({ slug: "guides", label: "Guides" });
			await registry.updateCollection("guides", { urlPattern: "/pages/{slug}" });

			const { ContentRepository } = await import("../../src/database/repositories/content.js");
			const repo = new ContentRepository(db);
			const page = await repo.create({
				type: "pages",
				slug: "about",
				status: "published",
				data: {},
			});
			const article = await repo.create({
				type: "articles",
				slug: "spring",
				status: "published",
				data: {},
			});
			const guide = await repo.create({
				type: "guides",
				slug: "about",
				status: "published",
				data: {},
			});

			const resolved = await resolvePublicContentPaths(
				db,
				[
					{ collection: "pages", id: page.id },
					{ collection: "articles", id: article.id },
					{ collection: "guides", id: guide.id },
				],
				{ publicRoutes: routes },
			);
			expect(resolved).toEqual([
				{ collection: "pages", id: page.id, path: "/pages/about" },
				{ collection: "articles", id: article.id, path: null },
				{ collection: "guides", id: guide.id, path: null },
			]);

			// Synthetic render assertion through the real pages/[slug].astro route
			getEmDashEntryMock.mockResolvedValueOnce({
				entry: {
					id: "about",
					data: {
						id: page.id,
						title: "About Us",
						content: [],
						translationGroup: page.translationGroup ?? page.id,
					},
					edit: { title: {}, content: {} },
				},
				cacheHint: undefined,
			});
			const container = await AstroContainer.create();
			const pageResponse = await container.renderToResponse(PageSlugRoute, {
				params: { slug: "about" },
				request: new Request("https://site.test/pages/about"),
			});
			expect(pageResponse.status).toBe(200);
			expect(await pageResponse.text()).toContain("About Us");

			// And the blog-cloudflare [...date].astro catch-all rejects unowned /journal/spring via /404 rewrite
			await expect(
				container.renderToResponse(DateArchiveRoute, {
					params: { date: "journal/spring" },
					request: new Request("https://site.test/journal/spring"),
				}),
			).rejects.toThrow(/\/404/);
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
