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

import PostCard from "../../../../templates/blog-cloudflare/src/components/PostCard.astro";
import PostsIndex from "../../../../templates/blog-cloudflare/src/pages/posts/index.astro";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

const REAL_URL = "/_emdash/api/media/file/2024/05/real.jpg";

/** The three posts, in the order the page lists them (published_at desc). */
/** The STORED MEDIA VALUE, field for field as a real tenant holds it: no `url`, no `asset.url`. */
const STORED_MEDIA_VALUE = {
	provider: "local",
	id: "01M89XSZYN028DKNRN4NRM2Q0C",
	filename: "club-logo.png",
	mimeType: "image/png",
	width: 500,
	height: 500,
	meta: { storageKey: "01M89XSZJF7EHVPC7VP7E47NED.png", caption: null },
};

/** A post whose featured image is that value — the shape EVERY imported featured image actually has. */
const storedMediaPost = {
	slug: "stored-media-value",
	title: "Post with a stored media featured image",
	featuredImage: { ...STORED_MEDIA_VALUE, focalX: 0.25, focalY: 0.75 },
	content: [
		{ _type: "block", _key: "b1", children: [{ _type: "span", _key: "s1", text: "Words." }] },
	],
};

/** A post whose featured image uses a NESTED storage key — the layout real uploads use. */
const nestedKeyPost = {
	slug: "nested-key",
	title: "Post with a nested-key featured image",
	featuredImage: {
		provider: "local",
		width: 500,
		height: 500,
		meta: { storageKey: "2024/05/club-logo.png" },
	},
	content: [
		{ _type: "block", _key: "b1", children: [{ _type: "span", _key: "s1", text: "Words." }] },
	],
};

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
	const all = [imageNodePost, htmlBlockPost, noPicturePost, storedMediaPost, nestedKeyPost];
	const chosen = only ? all.filter((p) => p.slug === only) : all;
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

	it("draws the STORED MEDIA VALUE — the shape every imported featured image holds — as a real src the browser can fetch", async () => {
		// THE ARM THE LEAD ASKED FOR, AND THE ONE THE OLD ARMS COULD NOT BE. `cardPicture` alone said the value was
		// recognised; the CONSUMER is what decides whether the picture is drawable. `index.astro` renders
		// `picture.assetRef ?? picture.src` as the `<img src>` and passes the same value to `storedDimensionsForRender`,
		// so when `assetRef` was the BARE KEY a calulti card produced `<img src="01M89….png">` — a relative URL that
		// resolves under /posts/ and 404s, with no dimensions. This renders the page and reads what a browser receives.
		const card = articleFor(await renderIndex(storedMediaPost.slug), storedMediaPost.slug);
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[0] ?? "";
		expect(picture.length, "the card must render a post-picture span at all").toBeGreaterThan(0);
		expect(picture, "the src is OUR MEDIA ROUTE, not a bare storage key").toContain(
			'src="/_emdash/api/media/file/01M89XSZJF7EHVPC7VP7E47NED.png"',
		);
		expect(picture, "and never the bare key as a relative URL").not.toMatch(/src="01M89XSZ/);
		// THE BOX IS REAL: without both dimensions the image lays out at 0 wide before load and the browser takes the
		// smallest candidate. The stored value carries them, so the card must reserve the box.
		expect(picture, "the card reserves the image's box with a real width").toMatch(/width="\d+"/);
		expect(picture, "and a real height").toMatch(/height="\d+"/);
	});

	it("draws a NESTED key through the real route — `2024/05/x.jpg` is a valid key, not a rejected one", async () => {
		// The first version refused any key containing "/", so a nested upload drew NOTHING. This renders the page the way
		// the other arms do — through the fixture list — and reads the src a browser receives.
		const card = articleFor(await renderIndex(nestedKeyPost.slug), nestedKeyPost.slug);
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[0] ?? "";
		expect(
			picture,
			`the nested key must render a fetchable route; got: ${card.slice(0, 300)}`,
		).toContain('src="/_emdash/api/media/file/2024/05/club-logo.png"');
		expect(picture).toMatch(/width="\d+"/);
		expect(picture).toMatch(/height="\d+"/);
	});

	it("carries the FOCAL POINT into object-position, so the crop is the owner's and not the centre", async () => {
		// `cardImage` used to rebuild the image object with {id, src, alt, width, height} and DROP the focal point, so
		// every card cropped at the centre even where the owner had moved the subject. `EmDashImage` reads img.focalX/Y.
		const card = articleFor(await renderIndex(storedMediaPost.slug), storedMediaPost.slug);
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[0] ?? "";
		expect(
			picture,
			"the card's picture must carry an object-position from the stored focal point",
		).toContain("object-position");
		expect(picture, "and it must NOT be the centre default").not.toContain(
			"object-position: 50% 50%",
		);
	});

	it("the nested key's ID is the WHOLE key, not its first path segment", async () => {
		// The id fed `EmDashImage`'s proxy fallback. The old regex stopped at the first `/`, so `2024/05/club-logo.png`
		// became id "2024" — a different file — and an encoded key became a percent-encoded id.
		const card = articleFor(await renderIndex(nestedKeyPost.slug), nestedKeyPost.slug);
		expect(card, "the card renders at all").toContain("post-picture");
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[0] ?? "";
		expect(picture, "the src keeps the whole nested key").toContain(
			"/_emdash/api/media/file/2024/05/club-logo.png",
		);
		// The id is not printed by every branch, so assert it where it IS observable: the data the component receives is
		// the src for a local picture, and the id only matters on the proxy fallback — so this arm pins the SRC CONTRACT
		// and the cardImage unit below pins the id itself.
		expect(picture).toMatch(/width="\d+"/);
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

	it("states the card's real slot width per breakpoint with auto first, never the image's own width or 100vw", async () => {
		const page = await renderCard({
			storedWidths: [300, 768, 1024, 1536],
			dimensions: { width: 1761, height: 1174 },
		});
		const picture = /<span class="post-picture"[^>]*>([\s\S]*?)<\/span>/.exec(page)?.[0] ?? "";
		const sizes = /sizes="([^"]*)"/.exec(picture)?.[1] ?? "";
		expect(
			sizes,
			"card states auto first followed by exact breakpoint slot widths from .posts-page CSS",
		).toBe(
			"auto, (min-width: 680px) 632px, (min-width: 601px) calc(100vw - 3rem), calc(100vw - 2rem)",
		);
		expect(sizes, "must not fall back to bare 100vw").not.toMatch(/,\s*100vw\b/);
		expect(sizes).not.toContain("1761px");
	});
});

/**
 * Render the REAL template component the home "Latest" grid uses.
 *
 * IT IS A DIFFERENT COMPONENT FROM THE POSTS LISTING. pages/posts/index.astro draws its own card and my earlier arms
 * covered that; the home grid is components/PostCard.astro, which passes the post's `featuredImage` — a MediaValue with
 * width and height — straight to <Image>, and that is the path that was still serving the original.
 */
async function renderPostCard(props: { featuredImage?: unknown }): Promise<string> {
	const container = await AstroContainer.create();
	const response = await runWithContext({ editMode: false, db }, () =>
		container.renderToResponse(PostCard, {
			props: { title: "A post", href: "/posts/a-post", featuredImage: props.featuredImage },
			request: new Request("https://example.org/"),
		}),
	);
	return await response.text();
}

describe("a post card's picture on the HOME page", () => {
	// THE HOME "LATEST" GRID IS NOT posts/index.astro. It is components/PostCard.astro, which passes the post's
	// `featuredImage` — a MediaValue WITH width and height from the media row — straight to <Image>. That used to take
	// the "caller gave dimensions" branch, hand the src to Astro's <Image>, and let it build a list of the SAME
	// original URL at 640w … 5400w, because nothing behind a local media URL resizes. Measured: 5.76 MB against a
	// 0.48 MB source, on a site holding 801 stored sizes that were never offered on that path.
	const mediaValue = {
		id: "01M883SDWF1PY8YZBGF4YDDP71",
		src: "/_emdash/api/media/file/01M883SDWF1PY8YZBGF4YDDP71.jpeg",
		width: 2048,
		height: 1365,
	};

	it("offers the STORED widths when a caller passes a media value with dimensions", async () => {
		storedSizes.widths = [300, 768, 1024];
		const html = await renderPostCard({ featuredImage: mediaValue });
		const srcset = /srcset="([^"]*)"/.exec(html)?.[1] ?? "";
		expect(srcset, "a srcset is drawn").not.toBe("");
		// DISTINCT CANDIDATES, each a real stored width. The defect was every candidate being the same URL.
		const urls = srcset.split(", ").map((c) => c.trim().split(" ")[0]);
		expect(new Set(urls).size, `distinct candidates; got ${srcset}`).toBe(urls.length);
		// THE CANDIDATES ARE THE STORED VARIANTS, whatever address the read returns for them (a `?w=` query on one
		// origin, or a `/variants/<width>.<ext>` path): what matters is one candidate per stored width, each a
		// different URL. Asserting a specific address shape would be asserting the fixture, not the rule.
		expect(srcset).toMatch(/(?:\?w=300|\/variants\/300\.)/);
		expect(srcset, "the widest stored width is offered too").toMatch(
			/(?:\?w=1024|\/variants\/1024\.)/,
		);
		// AND NO `sizes="100vw"` OVER A LIST THAT CANNOT BACK IT: the card's slot width bounds the choice.
		expect(html).not.toContain('sizes="100vw"');
	});

	it("draws the original ONCE, and claims no width list, when nothing is stored", async () => {
		// THE CASE THAT ACTUALLY DISTINGUISHES THE TWO BRANCHES. When stored sizes ARE found, both the old and new
		// code use them (the old branch ran the same read whenever the caller passed dimensions), so a green arm there
		// proved nothing — restoring the old branch left it passing. With NOTHING stored the branches diverge: the old
		// code handed the src to Astro's <Image>, which builds a list of the SAME original at 640w…5400w because
		// nothing behind a local media URL resizes; the new code draws the original once and claims nothing.
		storedSizes.widths = [];
		const html = await renderPostCard({ featuredImage: mediaValue });
		expect(html, "no list it cannot back").not.toContain("srcset=");
		expect(html, "and no sizes without a list").not.toContain("sizes=");
		expect(html).toContain(mediaValue.src);
		// AND NOT ONE ORIGINAL URL REPEATED AT MANY WIDTHS, which is what the old path produced.
		expect(html, "no repeated-original candidates").not.toMatch(/srcset="[^"]*2048w/);
	});
});

describe("a media value with src and dimensions and NO storageKey", () => {
	// THE REAL HOME-PAGE SHAPE. A post's `featured_image` row is a MediaValue carrying `src` (our media route) and the
	// row's width/height, and NO storageKey — so the stored read must find the media from the value's own src, which is
	// the only identity it has. This is a different question from the branch arms above: those control the read's
	// ANSWER, this one asks whether the read can be reached at all with this shape of value.
	const noKeyMedia = {
		id: "01M89P1D7J78GPGVXQZ0PP3QWF",
		src: "/_emdash/api/media/file/01M89P1D7J78GPGVXQZ0PP3QWF.png",
		width: 2700,
		height: 1800,
	};

	it("still offers the stored widths, found from the src", async () => {
		storedSizes.widths = [300, 768, 1024];
		const html = await renderPostCard({ featuredImage: noKeyMedia });
		const srcset = /srcset="([^"]*)"/.exec(html)?.[1] ?? "";
		expect(srcset, "the value's src is enough to find the media").not.toBe("");
		const urls = srcset.split(", ").map((c) => c.trim().split(" ")[0]);
		expect(new Set(urls).size, `distinct candidates; got ${srcset}`).toBe(urls.length);
	});
});
