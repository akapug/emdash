import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import CloudCategory from "../../../../templates/blog-cloudflare/src/pages/category/[slug].astro";
import CloudHome from "../../../../templates/blog-cloudflare/src/pages/index.astro";
import CloudPosts from "../../../../templates/blog-cloudflare/src/pages/posts/index.astro";
import CloudTag from "../../../../templates/blog-cloudflare/src/pages/tag/[slug].astro";

const TOTAL_POSTS = 25;

const state = vi.hoisted(() => ({
	postsPerPage: 10,
	withFeaturedImage: true,
}));

function makePost(index: number, withFeaturedImage: boolean) {
	const id = `post-${String(index + 1).padStart(2, "0")}`;
	return {
		id,
		edit: { title: {}, excerpt: {} },
		data: {
			id,
			title: `Post Title ${index + 1}`,
			excerpt: `Excerpt for post ${index + 1}`,
			publishedAt: new Date(Date.UTC(2026, 0, TOTAL_POSTS - index)),
			content: [
				{
					_type: "block",
					_key: `k-${index}`,
					style: "normal",
					children: [{ _type: "span", _key: `s-${index}`, text: "Body words here." }],
				},
			],
			featured_image:
				withFeaturedImage && index === 0
					? { id: "img-1", src: "/_emdash/api/media/file/img-1.jpg", alt: "Hero" }
					: undefined,
			bylines: [],
		},
	};
}

async function reads() {
	const seo =
		await vi.importActual<typeof import("../../src/seo/index.js")>("../../src/seo/index.js");
	return {
		...seo,
		getHomepage: async () => ({ entry: null, collection: null, cacheHint: {} }),
		getEmDashCollection: async (
			_collection: string,
			opts?: { limit?: number; offset?: number },
		) => {
			const all = Array.from({ length: TOTAL_POSTS }, (_, i) =>
				makePost(i, state.withFeaturedImage),
			);
			const offset = opts?.offset ?? 0;
			const limit = opts?.limit ?? all.length;
			const entries = all.slice(offset, offset + limit);
			return {
				entries,
				cacheHint: {},
				nextCursor: offset + limit < all.length ? `cursor-${offset + limit}` : null,
			};
		},
		getSiteSettings: async () => ({
			title: "Plain Blog",
			tagline: "Tagline",
			postsPerPage: state.postsPerPage,
		}),
		getSiteSettingsWithCacheHint: async () => ({
			data: {
				title: "Plain Blog",
				tagline: "Tagline",
				postsPerPage: state.postsPerPage,
				wpShell: null,
			},
			cacheHint: {},
		}),
		getTaxonomyTermsWithCacheHint: async (taxonomy: string) => ({
			data: [
				{
					id: `${taxonomy}-1`,
					slug: taxonomy === "category" ? "news" : "updates",
					label: taxonomy === "category" ? "News" : "Updates",
				},
			],
			cacheHint: {},
		}),
		getTermsForEntries: async () => new Map(),
		decodeSlug: (slug: string | undefined) => (slug ? decodeURIComponent(slug) : ""),
	};
}

vi.mock("emdash", reads);
vi.mock("../../dist/index.mjs", reads);
vi.mock("../../../../templates/blog-cloudflare/src/layouts/Base.astro", async () => ({
	default: (await import("./StubBase.astro")).default,
}));
vi.mock("../../../../templates/blog-cloudflare/src/components/PostCard.astro", async () => ({
	default: (await import("./StubPostCard.astro")).default,
}));

function countPostLinks(html: string): number {
	const matches = html.match(/href="\/posts\/post-\d+"/g);
	return matches ? new Set(matches).size : 0;
}

describe("plain look honors Settings → Posts Per Page (emb/145)", () => {
	it.each([3, 12])("home (/) renders %i posts when postsPerPage=%i", async (perPage) => {
		state.postsPerPage = perPage;
		state.withFeaturedImage = true;
		const container = await AstroContainer.create();
		const html = await container.renderToString(CloudHome, {
			request: new Request("https://example.org/"),
		});
		expect(countPostLinks(html)).toBe(perPage);
	});

	it("home (/) renders all 12 posts even when no post has a featured image", async () => {
		state.postsPerPage = 12;
		state.withFeaturedImage = false;
		const container = await AstroContainer.create();
		const html = await container.renderToString(CloudHome, {
			request: new Request("https://example.org/"),
		});
		expect(countPostLinks(html)).toBe(12);
	});

	it.each([3, 12])(
		"posts index (/posts) renders %i posts when postsPerPage=%i",
		async (perPage) => {
			state.postsPerPage = perPage;
			state.withFeaturedImage = true;
			const container = await AstroContainer.create();
			const html = await container.renderToString(CloudPosts, {
				request: new Request("https://example.org/posts"),
			});
			expect(countPostLinks(html)).toBe(perPage);
		},
	);

	it.each([3, 12])(
		"category archive (/category/news) renders %i posts when postsPerPage=%i",
		async (perPage) => {
			state.postsPerPage = perPage;
			state.withFeaturedImage = true;
			const container = await AstroContainer.create();
			const html = await container.renderToString(CloudCategory, {
				params: { slug: "news" },
				request: new Request("https://example.org/category/news"),
			});
			expect(countPostLinks(html)).toBe(perPage);
		},
	);

	it.each([3, 12])(
		"tag archive (/tag/updates) renders %i posts when postsPerPage=%i",
		async (perPage) => {
			state.postsPerPage = perPage;
			state.withFeaturedImage = true;
			const container = await AstroContainer.create();
			const html = await container.renderToString(CloudTag, {
				params: { slug: "updates" },
				request: new Request("https://example.org/tag/updates"),
			});
			expect(countPostLinks(html)).toBe(perPage);
		},
	);
});
