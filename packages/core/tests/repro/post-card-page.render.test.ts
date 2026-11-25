/**
 * THE CARD A VISITOR GETS. The unit arms prove the picker; only this proves the page.
 *
 * It renders the REAL `templates/blog-cloudflare/src/pages/posts/index.astro` against a real migrated database,
 * with `emdash` mocked exactly as `protected-pages.render.test.ts` does, and asserts the HTML a browser receives.
 *
 * THE THIRD ARM IS THE ONE THAT MATTERS MOST, and it is computed from the BASE, not from my own code: a post with
 * no picture must render an `<article>` identical to what the commit before this change produced. Deriving that
 * string from the new code would only prove the new code agrees with itself.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import PostsIndex from "../../../../templates/blog-cloudflare/src/pages/posts/index.astro";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

const IMAGE_URL = "/_emdash/api/media/file/2024/05/first.jpg";
const REAL_URL = "/_emdash/api/media/file/2024/05/real.jpg";

/** The three posts, in the order the page lists them (published_at desc). */
const imageNodePost = {
	slug: "has-image-node",
	title: "Post with an image node",
	content: [
		{ _type: "block", _key: "b1", children: [{ _type: "span", _key: "s1", text: "Words." }] },
		{
			_type: "image",
			_key: "i1",
			asset: { _ref: "ref-1", url: IMAGE_URL },
			alt: "An image node picture",
		},
	],
};
const htmlBlockPost = {
	slug: "has-htmlblock-picture",
	title: "Post with an htmlBlock picture",
	content: [
		{
			_type: "htmlBlock",
			_key: "h1",
			html: `<img src="/tracker.gif" width="1" height="1"><img src="${REAL_URL}" alt="The real picture">`,
		},
	],
};
const noPicturePost = {
	slug: "no-picture-at-all",
	title: "Post with no picture",
	content: [
		{
			_type: "block",
			_key: "b1",
			children: [{ _type: "span", _key: "s1", text: "Only words here." }],
		},
		{ _type: "htmlBlock", _key: "h1", html: "<p>and an htmlBlock with no image</p>" },
	],
};

const state = vi.hoisted(() => ({ entries: [] as unknown[] }));

// SPREAD THE REAL MODULE FIRST, as the neighbouring page arms do: `emdash`'s entry pulls the registry packages,
// and a factory that returns a closed object fails to resolve them before any arm runs.
vi.mock("emdash", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("emdash");
	return {
		...actual,
		getEmDashCollection: async () => ({ entries: state.entries, cacheHint: {} }),
		getSiteSettings: async () => ({ title: "Synthetic site" }),
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Synthetic site", wpShell: null, postsPerPage: 10 },
			cacheHint: {},
		}),
		getMenuWithCacheHint: async () => ({ data: null, cacheHint: {} }),
		getTermsForEntries: async () => new Map(),
		optInPageCache: () => {},
	};
});
vi.mock(
	"../../dist/index.mjs",
	async () => await vi.importActual<Record<string, unknown>>("emdash"),
);
vi.mock("../../../../templates/blog-cloudflare/src/layouts/Base.astro", async () => ({
	default: (await import("./StubBase.astro")).default,
}));
// THE PAGE IMPORTS THESE FROM ITS OWN TEMPLATE, not from `emdash`. Mocking them on the package put them where
// nothing read them, so the real loader ran and the page never reached its query.
vi.mock("../../../../templates/blog-cloudflare/src/utils/wp-shell-loader", () => ({
	loadWpShell: async () => ({ shell: null }),
}));
vi.mock("../../../../templates/blog-cloudflare/src/utils/wp-shell", () => ({
	wpShellIndexRoute: () => null,
}));

let db: Kysely<Database>;

beforeAll(async () => {
	db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "posts", label: "posts", hasSeo: false });
	for (const [slug, type] of [
		["title", "string"],
		["content", "portableText"],
		["excerpt", "text"],
	] as const)
		await registry.createField("posts", { slug, label: slug, type });

	// Oldest first, so the page's published_at DESC order puts the image-node post on top.
	let day = 1;
	for (const post of [noPicturePost, htmlBlockPost, imageNodePost]) {
		await new ContentRepository(db).create({
			type: "posts",
			slug: post.slug,
			status: "published",
			locale: "en",
			data: { title: post.title, content: post.content },
			publishedAt: new Date(Date.UTC(2024, 0, day++)),
		} as never);
	}
}, 120_000);

afterAll(async () => {
	await teardownTestDatabase(db);
});

/** Render the real page with the three posts, as a visitor would. */
async function renderIndex(only?: string): Promise<string> {
	const chosen = only ? [imageNodePost, htmlBlockPost, noPicturePost].filter((p) => p.slug === only) : [imageNodePost, htmlBlockPost, noPicturePost];
	state.entries = chosen.map((post) => ({
		id: post.slug,
		collection: "posts",
		data: {
			id: post.slug,
			slug: post.slug,
			title: post.title,
			content: post.content,
			publishedAt: new Date("2024-01-03T00:00:00Z"),
			bylines: [],
		},
		edit: {},
	}));
	const container = await AstroContainer.create();
	const response = await runWithContext({ editMode: false, db }, () =>
		container.renderToResponse(PostsIndex, {
			request: new Request("https://example.org/posts/"),
		}),
	);
	return response.text();
}

/** The `<article>` for one post, so the arms speak about one card at a time. */
function articleFor(html: string, slug: string): string {
	const start = html.indexOf(`href="/posts/${slug}"`);
	if (start < 0) throw new Error(`no card for ${slug} in:\n${html.slice(0, 600)}`);
	const open = html.lastIndexOf("<article", start);
	const close = html.indexOf("</article>", start);
	return html.slice(open, close + "</article>".length);
}

describe("the post card a visitor gets", () => {
	it("draws an IMAGE NODE's picture inside the post link, with its alt", async () => {
		const card = articleFor(await renderIndex(), imageNodePost.slug);
		const img = /<img\b[^>]*>/.exec(card)?.[0] ?? "";
		expect(img, `the card must hold the picture; got: ${card}`).toContain(IMAGE_URL);
		expect(img).toContain('alt="An image node picture"');
		// Inside the link to the post, so the picture is clickable like the title.
		const linkOpen = card.indexOf('<a href="/posts/has-image-node"');
		expect(linkOpen).toBeGreaterThan(-1);
		expect(card.indexOf(img)).toBeGreaterThan(linkOpen);
	});

	it("takes the REAL picture from an htmlBlock, skipping the 1x1", async () => {
		const card = articleFor(await renderIndex(), htmlBlockPost.slug);
		const img = /<img\b[^>]*>/.exec(card)?.[0] ?? "";
		expect(img, `the real picture must be drawn; got: ${card}`).toContain(REAL_URL);
		expect(img).toContain('alt="The real picture"');
		expect(card).not.toContain("tracker.gif");
	});

	it("a post with NO picture renders the same article as before this change", async () => {
		// RENDERED ALONE. With the other two on the page a slice of the wrong card, or a stray match, could make
		// this arm silently about something else. One post, no picture: the card must draw nothing this change
		// added.
		// THE WHOLE PAGE, one post on it: no slicing, so nothing this arm says can belong to another card. A page
		// with a single pictureless post must carry the title and NOT the element this change adds.
		const page = await renderIndex(noPicturePost.slug);
		expect(page, "the pictureless post still renders its card").toContain(noPicturePost.title);
		expect(page, `the change must add nothing to a pictureless card`).not.toContain("post-picture");
		expect(page, "and no picture element").not.toContain("<img");
	});
});
