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

const REAL_URL = "/_emdash/api/media/file/2024/05/real.jpg";

/** The three posts, in the order the page lists them (published_at desc). */
const imageNodePost = {
	slug: "has-image-node",
	title: "Post with a featured image",
	// A FEATURED IMAGE IS THE ONE THING A CARD DRAWS BY DEFAULT. The first version of this fixture relied on the
	// card walking the post's content for a picture; that rule was measured on one theme and most themes draw nothing
	// without a featured image, so it is now a site setting (off) and the card's default path is this value.
	featuredImage: {
		asset: { _type: "reference", _ref: "/_emdash/api/media/file/01M883SDWF1PY8YZBGF4YDDP71.jpeg" },
	},
	content: [
		{ _type: "block", _key: "b1", children: [{ _type: "span", _key: "s1", text: "Words." }] },
		{
			_type: "image",
			_key: "i1",
			// THE MEASURED SHAPE, taken from a real post's content (optest-dreamingstone-ac, ec_posts,
			// 2024-annual-report): the ref is a FULL PATH to the media-file route, not a bare id, and `url` carries
			// the same value. An invented ref here is what let a doubled-path bug through.
			asset: {
				_ref: "/_emdash/api/media/file/01M883SDWF1PY8YZBGF4YDDP71.jpeg",
				url: "/_emdash/api/media/file/01M883SDWF1PY8YZBGF4YDDP71.jpeg",
			},
			alt: "An image node picture",
		},
	],
};
const htmlBlockPost = {
	slug: "has-htmlblock-picture",
	title: "Post with no featured image",
	// NO FEATURED IMAGE, and a picture in its content that a card must NOT draw: the content-first rule is off by
	// default, because a site whose listing was never seen doing it should not gain pictures it never showed.
	featuredImage: undefined,
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
/** What the stored-sizes read answers for the next render: the widths this tenant holds, or none. */
const storedSizes = vi.hoisted(() => ({
	widths: [] as number[],
	/** The media row's own size, or null when the row records none. */
	dimensions: null as { width: number; height: number } | null,
}));

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
		// THE TEMPLATE IMPORTS THIS FROM `emdash`, not from the media module, so the module-level stub above never
		// reaches it — a mock has to land on the specifier the code actually uses.
		storedDimensionsForRender: async () => storedSizes.dimensions,
	};
}
vi.mock("emdash", reads);
// THE VARIANT READ, stubbed at the module so an arm can say what the tenant holds. Returning null is the real
// no-stored-sizes answer and is what the card must render honestly.
// THE COMPONENT IMPORTS `../media/variant-read.js`; vitest matches the SPECIFIER, so a mock on the .ts path
// never applied and the real read ran — throwing in this harness and failing every card arm in 1-22 ms.
// Both spellings are mocked so the arm measures the card, not the resolvability of a module id.
vi.mock("../../src/media/variant-read.js", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../../src/media/variant-read.js");
	return {
		...actual,
		storedDimensionsForRender: async () => storedSizes.dimensions,
		storedSizesForRender: async (_media: unknown, width: number) => {
			const widths = storedSizes.widths.filter((w) => w <= width);
			if (widths.length === 0) return null;
			return {
				srcset: widths.map((w) => `/variants/${w}.png ${w}w`).join(", "),
				sizes: `(max-width: ${width}px) 100vw, ${width}px`,
			};
		},
	};
});
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
		// THE FIELD A CARD DRAWS BY DEFAULT. Without it the column does not exist and the insert fails, which is how
		// this arm found out that a featured image must be DECLARED on the collection — not merely written to.
		["featured_image", "json"],
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
			data: {
				title: post.title,
				content: post.content,
				...(post.featuredImage ? { featured_image: post.featuredImage } : {}),
			},
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
			// THE ENTRY THE PAGE READS, so the mock's data matches what the row holds.
			...(post.featuredImage ? { featured_image: post.featuredImage } : {}),
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

/**
 * Render the index with the variant read answering as the arm needs.
 *
 * THE PICTURE'S WIDTH LIST IS THE SUBJECT, so the read is the one thing this helper controls: `storedWidths` empty
 * means the tenant holds no sizes for the row, which is the case that used to emit a list of one URL at many widths.
 */
async function renderCard(opts: {
	storedWidths: number[];
	dimensions?: { width: number; height: number } | null;
}): Promise<string> {
	// THE STORED-SIZES AND DIMENSION READS ARE STUBBED AT THE MODULE, not through a hook in production code: a test
	// seam in the shipped module is a leak, and this file already stubs its reads the same way.
	storedSizes.widths = opts.storedWidths;
	storedSizes.dimensions = opts.dimensions ?? null;
	return await renderIndex();
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
	it("draws the FEATURED image inside the post link", async () => {
		const card = articleFor(await renderIndex(), imageNodePost.slug);
		// THE PICTURE ELEMENT, not merely the first <img> in the card: a byline avatar is also an <img>, and taking
		// the first match would let this arm pass or fail on chrome the change never touches.
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[0] ?? "";
		// A STORED ASSET IS DRAWN BY ITS REF, not by its url — that is what the template does and what the image
		// component needs. So the card carries the media-file route for the ref, and the arm reads that.
		// A STORED ASSET IS DRAWN BY ITS REF through the media-file route — that is what the template does, and
		// this post's node carries `_ref: "ref-1"`. Asserting the raw url here would fail on correct output.
		// THE REF IS DRAWN AS IT ARRIVED — a full path, exactly once. A doubled
		// `/_emdash/api/media/file//_emdash/api/media/file/...` is what prefixing used to produce, and it 404s.
		// A FAILURE THAT CARRIES A FACT, NOT A MESSAGE: if the card's markup has no post-picture span, say so as an
		// assertion — those text reaches vitest's own diff, which every reporter prints.
		expect(picture.length, "the card must render a post-picture span at all").toBeGreaterThan(0);
		expect(picture.includes("<img"), "and the span must hold an img").toBe(true);
		expect(
			picture.includes("emdash-image-media"),
			"and the picture must be drawn by the image component",
		).toBe(true);
		expect(picture, `the card must hold the picture wrapper; got: ${card}`).toContain(
			'src="/_emdash/api/media/file/01M883SDWF1PY8YZBGF4YDDP71.jpeg"',
		);
		expect(picture, `the route must not be prefixed twice; got: ${picture}`).not.toContain(
			"file//_emdash",
		);
		// THE ALT COMES FROM THE FEATURED VALUE; with the content-first rule off there is no node to read one from.
		expect(picture, "the picture must carry an alt").toMatch(/alt="[^"]*"/);
		// Inside the link to the post, so the picture is clickable like the title.
		const linkOpen = card.indexOf('<a href="/posts/has-image-node"');
		expect(linkOpen).toBeGreaterThan(-1);
		expect(card.indexOf(picture)).toBeGreaterThan(linkOpen);
	});

	it("draws NO picture for a post whose only picture is in its content", async () => {
		// A POST WITH NO FEATURED IMAGE DRAWS NO CARD PICTURE, even though its content holds one. The content-first
		// rule was measured on ONE theme; most themes draw nothing here, so applying it everywhere would add pictures
		// the source never showed. It is a site setting, off by default, and this arm pins the default.
		const card = articleFor(await renderIndex(), htmlBlockPost.slug);
		expect(card, `no picture wrapper without a featured image; got: ${card}`).not.toContain(
			"post-picture",
		);
		expect(card, "and nothing is drawn from the content").not.toContain(REAL_URL);
		expect(card, "the card still renders its title").toContain(htmlBlockPost.title);
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

describe("a post card's picture never promises a width it cannot back", () => {
	it("with row dimensions and stored sizes, the card draws DISTINCT variant URLs and a card-width sizes", async () => {
		// THE POINT OF THE DIMENSION READ: with the row's own size the component can offer the widths the tenant holds,
		// which is the whole reason this lane exists — a card drawing a 5.6 MB original is the defect. The sizes value
		// must describe a CARD, not a viewport.
		const page = await renderCard({
			storedWidths: [300, 768],
			dimensions: { width: 1200, height: 800 },
		});
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(page)?.[0] ?? "";
		const srcset = /srcset="([^"]{1,500})"/.exec(picture)?.[1] ?? "";
		expect(
			picture.includes('width="1200"') || picture.includes("width='1200'"),
			`the row's size must reach the markup; got: ${picture}`,
		).toBe(true);
		expect(srcset, `the card must offer the stored widths it now can; got: ${picture}`).not.toBe(
			"",
		);
		const urls = srcset.split(",").map((part) => part.trim().split(" ")[0]);
		expect(new Set(urls).size, `every candidate must be a DIFFERENT url; got: ${srcset}`).toBe(
			urls.length,
		);
		expect(picture, `a card-width sizes, not 100vw; got: ${picture}`).not.toContain(
			'sizes="100vw"',
		);
	});

	it("with stored sizes but no dimensions of its own, the card still renders and claims NO width list", async () => {
		// MEASURED, and it corrects the arm I first wrote: a card passes `src` and `alt` and no dimensions, and
		// Astro's <Image> REFUSES a remote src without them ("both dimensions are required in order to avoid CLS") —
		// so a card cannot be drawn through it at all, with or without stored sizes. The honest output is the
		// original once, no srcset and no sizes: never the fake `640w … 5400w` list of one URL, and never a page that
		// throws. Promising stored widths needs the dimensions, which the card path does not have yet.
		const page = await renderCard({ storedWidths: [300, 768] });
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(page)?.[0] ?? "";
		expect(picture, "the card still draws its picture").toContain("<img");
		expect(picture, `no srcset the card cannot back; got: ${picture}`).not.toContain("srcset=");
		expect(picture, `and no sizes to make a browser prefer it; got: ${picture}`).not.toContain(
			"sizes=",
		);
		expect(picture, "the original is what is drawn").toContain("01M883SDWF1PY8YZBGF4YDDP71.jpeg");
	});

	it("with NO stored sizes, the card draws the original ONCE and claims no width list", async () => {
		// DECISION (a): no list at all. A list of one URL pretending to be many is the failure this lane exists for,
		// so the honest markup is one `src`, no `srcset`, and no `sizes` to tell a browser to prefer a "bigger" entry
		// that is the same file.
		const page = await renderCard({ storedWidths: [] });
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(page)?.[0] ?? "";
		expect(picture, "the card still draws its picture").toContain("<img");
		expect(picture, `no srcset when nothing is stored; got: ${picture}`).not.toContain("srcset=");
		expect(picture, `and no sizes either; got: ${picture}`).not.toContain("sizes=");
	});
});
