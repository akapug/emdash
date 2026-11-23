/**
 * Native v1 posts-grid block renderer (task/12701): verifies that `PostsGrid.astro`
 * renders migrated WPBakery `[vc_posts_grid]` blocks in BOTH `BlogPortableText`
 * (plain blog look) and `WpShell` (Look-C shell), emits the `emdash-posts-grid-v1`
 * marker, respects `count` / `order` / `excludeEntry`, and safely ignores invalid
 * block versions or unsupported collections.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BlogPortableText from "../../../../templates/blog-cloudflare/src/components/BlogPortableText.astro";
import WpShell from "../../../../templates/blog-cloudflare/src/layouts/WpShell.astro";

const reads = vi.hoisted(() => ({
	getEmDashCollection: vi.fn(),
}));

async function emdashReads() {
	const seo = await import("../../src/seo/index.js");
	const sanitize = await import("../../src/utils/sanitize.js");
	const url = await import("../../src/utils/url.js");
	return {
		getSeoMeta: seo.getSeoMeta,
		getContentSeo: seo.getContentSeo,
		sanitizeContent: sanitize.sanitizeContent,
		sanitizeHref: url.sanitizeHref,
		getEditMeta: () => undefined,
		getEmDashCollection: reads.getEmDashCollection,
		getPublishedDates: async () => ({ dates: [], cacheHint: {} }),
		getMenuWithCacheHint: async () => ({ data: null, cacheHint: {} }),
		getSiteSettingsWithCacheHint: async () => ({ data: { title: "Example" }, cacheHint: {} }),
		getWidgetAreaWithCacheHint: async () => ({ data: null, cacheHint: {} }),
	};
}

vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);
vi.mock("../../../../templates/blog-cloudflare/src/components/PostCard.astro", async () => ({
	default: (await import("./StubPostCard.astro")).default,
}));

// The REAL shape: an entry's `id` is its public id (the slug the link uses) and `data.id` its database row id.
// The importer writes excludeEntry.id as the DATABASE id (packages/host/src/import/shortcode-resolvers.ts, f.row().id),
// so a fixture whose two ids are equal could not tell which one the renderer compares.
const samplePosts = [
	{
		id: "first-post",
		data: { id: "01P1", title: "First Post", excerpt: "One", publishedAt: new Date("2026-11-01") },
		edit: {},
	},
	{
		id: "second-post",
		data: { id: "01P2", title: "Second Post", excerpt: "Two", publishedAt: new Date("2026-11-02") },
		edit: {},
	},
	{
		id: "third-post",
		data: {
			id: "01P3",
			title: "Third Post",
			excerpt: "Three",
			publishedAt: new Date("2026-11-03"),
		},
		edit: {},
	},
];

const gridBlock = (overrides: Record<string, unknown> = {}) => ({
	_type: "posts-grid",
	_key: "pg-1",
	version: 1,
	collection: "posts",
	count: 2,
	orderBy: "date",
	order: "desc",
	excludeEntry: { collection: "posts", id: "01P1" },
	...overrides,
});

describe("PostsGrid v1 renderer (task/12701)", () => {
	beforeEach(() => {
		reads.getEmDashCollection.mockReset();
		reads.getEmDashCollection.mockResolvedValue({ entries: samplePosts, cacheHint: {} });
	});

	it("renders in BlogPortableText with emdash-posts-grid-v1 marker, excludes containing entry, and caps to count", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(BlogPortableText, {
			props: { value: [gridBlock()] },
		});
		expect(reads.getEmDashCollection).toHaveBeenCalledWith("posts", {
			orderBy: { published_at: "desc" },
			limit: 3,
		});
		expect(html).toContain("emdash-posts-grid-v1");
		expect(html).not.toContain("First Post");
		expect(html).toContain("Second Post");
		expect(html).toContain("Third Post");
	});

	it("renders inside WpShell (Look-C) as well", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(WpShell, {
			props: {
				shell: {
					version: 1,
					id: "0123456789abcdef01234567",
					source: { url: "https://example.org/", capturedAt: "2026-11-23T00:00:00.000Z" },
					html: { lang: "en-US", class: "" },
					body: { class: "page" },
					styles: ["/_emdash/api/media/file/wp-shell/abc.css"],
					menus: [],
					parts: [
						{ html: "<main>" },
						{ slot: "title", tag: "h1" },
						{ slot: "content", tag: "div" },
						{ html: "</main>" },
					],
				},
				kind: "page",
				path: "/",
				title: "Home",
				entry: { title: "Home", body: [gridBlock({ order: "asc", excludeEntry: undefined })] },
			},
		});
		expect(reads.getEmDashCollection).toHaveBeenCalledWith("posts", {
			orderBy: { published_at: "asc" },
			limit: 2,
		});
		expect(html).toContain("emdash-posts-grid-v1");
		expect(html).toContain("First Post");
		expect(html).toContain("Second Post");
		expect(html).not.toContain("Third Post");
	});

	it("draws nothing and makes no query for unsupported versions or collections", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(BlogPortableText, {
			props: {
				value: [gridBlock({ version: 2 }), gridBlock({ collection: "users" })],
			},
		});
		expect(reads.getEmDashCollection).not.toHaveBeenCalled();
		expect(html).not.toContain("emdash-posts-grid-v1");
	});
});
