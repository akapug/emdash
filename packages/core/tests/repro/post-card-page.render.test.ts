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
async function reads() {
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
}
vi.mock("emdash", reads);
// THE TEMPLATE RESOLVES `emdash` TO dist/index.mjs, so the mock must land THERE with the same reads object. This
// used to spread the actual module, which meant the page ran the real query and ignored `state.entries` — every arm
// then measured whatever the fixture database held, not the three posts the arm described.
vi.mock("../../dist/index.mjs", reads);
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
	const chosen = only
		? [imageNodePost, htmlBlockPost, noPicturePost].filter((p) => p.slug === only)
		: [imageNodePost, htmlBlockPost, noPicturePost];
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
		// THE PICTURE ELEMENT, not merely the first <img> in the card: a byline avatar is also an <img>, and taking
		// the first match would let this arm pass or fail on chrome the change never touches.
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[0] ?? "";
		// A STORED ASSET IS DRAWN BY ITS REF, not by its url — that is what the template does and what the image
		// component needs. So the card carries the media-file route for the ref, and the arm reads that.
		// A STORED ASSET IS DRAWN BY ITS REF through the media-file route — that is what the template does, and
		// this post's node carries `_ref: "ref-1"`. Asserting the raw url here would fail on correct output.
		expect(picture, `the card must hold the picture wrapper; got: ${card}`).toContain(
			"/_emdash/api/media/file/ref-1",
		);
		expect(picture, "with the alt the image node carries").toContain('alt="An image node picture"');
		// Inside the link to the post, so the picture is clickable like the title.
		const linkOpen = card.indexOf('<a href="/posts/has-image-node"');
		expect(linkOpen).toBeGreaterThan(-1);
		expect(card.indexOf(picture)).toBeGreaterThan(linkOpen);
	});

	it("takes the REAL picture from an htmlBlock, skipping the 1x1", async () => {
		const card = articleFor(await renderIndex(), htmlBlockPost.slug);
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[0] ?? "";
		expect(picture, `the real picture must be drawn; got: ${card}`).toContain(REAL_URL);
		expect(picture).toContain('alt="The real picture"');
		expect(card, "the 1x1 is never the picture").not.toContain("tracker.gif");
	});

	it("a post with NO picture renders the same article as before this change", async () => {
		// RENDERED ALONE. With the other two on the page a slice of the wrong card, or a stray match, could make
		// this arm silently about something else. One post, no picture: the card must draw nothing this change
		// added.
		// THE WHOLE PAGE, one post on it: no slicing, so nothing this arm says can belong to another card. A page
		// with a single pictureless post must carry the title and NOT the element this change adds.
		const page = await renderIndex(noPicturePost.slug);
		expect(page, "the pictureless post still renders its card").toContain(noPicturePost.title);
		// THE CLAIM IS ABOUT WHAT THIS CHANGE ADDS, so it is asserted on the element it adds. The page may legitimately
		// carry an <img> from chrome this change never touches (a byline avatar, a logo); what must be absent is the
		// card picture wrapper and any media-file src the picker would have produced.
		expect(page, "the change must add nothing to a pictureless card").not.toContain("post-picture");
		expect(page, "and no media-file picture the picker would have chosen").not.toContain(
			"first.jpg",
		);
		expect(page, "nor the htmlBlock picture").not.toContain("real.jpg");
	});
});
