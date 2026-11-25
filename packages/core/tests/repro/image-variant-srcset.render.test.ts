/**
 * Stored image sizes must reach the markup of a page a visitor requests.
 *
 * Two things made a site with stored variants serve unchanged pages, and each was
 * invisible to every other arm:
 *
 *  - The components gated the read on `Astro.locals.emdash.db`. A logged-out request
 *    has no such handle (the middleware's anonymous path attaches a partial handler
 *    object), so the read never ran for a visitor.
 *  - `EmDashImage` then handed a same-origin image to `<AstroImage>`, which takes
 *    `src` alone and derives a srcset of its own.
 *
 * So these arms render the real components against a real database that is reachable
 * only the way a public request reaches it: through the request context. Nothing is
 * placed on `locals.emdash.db`.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Cover from "../../src/components/Cover.astro";
import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";
import Image from "../../src/components/Image.astro";
import { MediaRepository } from "../../src/database/repositories/media.js";
import type { Database } from "../../src/database/types.js";
import { invalidateVariants } from "../../src/media/variant-read.js";
import { runWithContext } from "../../src/request-context.js";
import { createTestDatabase, setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

const FILE = "/_emdash/api/media/file/";
const CURRENT = "hash-of-the-current-bytes";
const internalUrl = (key: string) => `${FILE}${key}`;

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

describe("stored image sizes on a logged-out page", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		// The cross-request cache outlives a test database.
		invalidateVariants();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	/**
	 * A ready image and one variant row per `[width, parentHash]`.
	 *
	 * `stored` is the pixel frame the parent row holds; `upright` is the picture a
	 * browser draws, which differs for a photo stored on its side with an orientation
	 * flag. Variants are generated upright, so their heights follow `upright`.
	 */
	async function seed(
		storageKey: string,
		variants: Array<[number, string]>,
		stored: [number, number] = [1600, 900],
		upright: [number, number] = stored,
	) {
		const svg = storageKey.endsWith(".svg");
		const parent = await new MediaRepository(db).create({
			filename: svg ? "graphic.svg" : "photo.jpg",
			mimeType: svg ? "image/svg+xml" : "image/jpeg",
			storageKey,
			size: 4_000_000,
			width: stored[0],
			height: stored[1],
			contentHash: CURRENT,
			status: "ready",
		});
		for (const [width, parentContentHash] of variants) {
			await db
				.insertInto("_emdash_media_variants")
				.values({
					media_id: parent.id,
					size_name: `w${width}`,
					width,
					height: Math.round((width * upright[1]) / upright[0]),
					storage_key: `media-variants/${parent.id}/${parentContentHash}/${width}`,
					bytes: width * 100,
					content_hash: `variant-${width}`,
					parent_content_hash: parentContentHash,
				})
				.execute();
		}
	}

	type Component = Parameters<AstroContainer["renderToString"]>[0];
	const locals = (publicUrl: (key: string) => string = internalUrl) => ({
		emdash: { getPublicMediaUrl: publicUrl },
	});

	/** Exactly what the anonymous path provides: a request context, and no `db` on locals. */
	async function asVisitor(
		component: Component,
		props: Record<string, unknown>,
		publicUrl?: (key: string) => string,
		database: Kysely<Database> = db,
	): Promise<string> {
		const container = await AstroContainer.create();
		return runWithContext({ editMode: false, db: database }, () =>
			container.renderToString(component, { props, locals: locals(publicUrl) }),
		);
	}

	/** The same render with no database anywhere: a static build, or a site with no variants. */
	async function withNoDatabase(
		component: Component,
		props: Record<string, unknown>,
	): Promise<string> {
		const container = await AstroContainer.create();
		return container.renderToString(component, { props, locals: locals() });
	}

	const image = (storageKey: string, extra: Record<string, unknown> = {}) => ({
		image: {
			src: internalUrl(storageKey),
			storageKey,
			alt: "a photo",
			width: 1600,
			height: 900,
			...extra,
		},
	});

	// An imported content image usually carries no dimensions of its own.
	const block = (storageKey: string, extra: Record<string, unknown> = {}) => ({
		node: {
			_type: "image",
			_key: "i1",
			asset: { _ref: "ref", url: internalUrl(storageKey) },
			...extra,
		},
	});

	const tagFor = (html: string, name: string) => {
		const tag = imgTags(html).find((t) => t.includes(name)) ?? "";
		expect(tag, `${name} must render`).not.toBe("");
		return tag;
	};

	it("EmDashImage offers each stored width of the current bytes, and no other", async () => {
		const key = "2024/05/visitor.jpg";
		// 480 belongs to bytes that were since replaced: stored, but not committed.
		await seed(key, [
			[300, CURRENT],
			[480, "hash-of-replaced-bytes"],
			[1024, CURRENT],
		]);
		const tag = tagFor(await asVisitor(EmDashImage, image(key)), "visitor.jpg");
		// Stored sizes only: an EmDashImage does not know the slot it fills.
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key}?w=1024 1024w`);
		// The fallback source is the original, and the layout attributes are kept.
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "width")).toBe("1600");
		expect(attr(tag, "height")).toBe("900");
		expect(attr(tag, "loading")).toBe("lazy");
		expect(attr(tag, "fetchpriority")).toBeUndefined();
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 1600px) 1600px, 100vw");
	});

	it.each([
		{
			name: "priority",
			attrs: { priority: true },
			loading: "eager",
			fetchpriority: "high",
		},
		{ name: "explicit eager loading", attrs: { loading: "eager" }, loading: "eager" },
		{ name: "omitted loading", attrs: { loading: undefined }, loading: undefined },
		{
			name: "explicit sizes",
			attrs: { sizes: "(max-width: 600px) 90vw,  240px" },
			loading: "lazy",
		},
		{
			name: "density descriptors",
			attrs: { srcset: "/density.jpg 1x, /density@2x.jpg 2x" },
			loading: "lazy",
		},
		{ name: "omitted srcset", attrs: { srcset: undefined }, loading: "lazy" },
	])("EmDashImage preserves the rendered attributes with $name", async (control) => {
		const key = "2024/05/feature.jpg";
		await seed(key, [
			[300, CURRENT],
			[1024, CURRENT],
		]);
		const tag = tagFor(
			await asVisitor(EmDashImage, { ...image(key), width: 480, height: 270, ...control.attrs }),
			key,
		);
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "srcset")).toBe(
			"srcset" in control.attrs
				? control.attrs.srcset
				: `${FILE}${key}?w=300 300w, ${FILE}${key}?w=1024 1024w`,
		);
		expect(attr(tag, "sizes")).toBe(control.attrs.sizes ?? "(min-width: 480px) 480px, 100vw");
		expect(attr(tag, "loading")).toBe(control.loading);
		expect(attr(tag, "fetchpriority")).toBe(control.fetchpriority);
	});

	it("EmDashImage keeps the size hint for SVG even when the store offers widths", async () => {
		const key = "2024/05/graphic.svg";
		await seed(key, [
			[300, CURRENT],
			[1024, CURRENT],
		]);
		const tag = tagFor(
			await asVisitor(EmDashImage, { ...image(key), width: 480, height: 270 }),
			key,
		);
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key}?w=1024 1024w`);
		expect(attr(tag, "loading")).toBe("lazy");
		expect(attr(tag, "sizes")).toBe("(min-width: 480px) 480px, 100vw");
	});

	it("EventCover emits auto sizes on the event card's lazy image", async () => {
		const { default: EventCover } =
			await import("../../../../templates/blog-cloudflare/src/components/EventCover.astro");
		const key = "2024/05/event.jpg";
		await seed(key, [
			[300, CURRENT],
			[768, CURRENT],
			[1024, CURRENT],
		]);
		const tag = tagFor(await asVisitor(EventCover, image(key, { width: 480, height: 270 })), key);
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key}?w=1024 1024w`,
		);
		expect(attr(tag, "loading")).toBe("lazy");
		expect(attr(tag, "fetchpriority")).toBeUndefined();
		expect(attr(tag, "width")).toBe("480");
		expect(attr(tag, "height")).toBe("270");
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 480px) 480px, 100vw");
	});

	it("EmDashImage builds its candidates on the file route, whatever address draws the image", async () => {
		const key = "elsewhere.jpg";
		await seed(key, [[300, CURRENT]]);
		// Same origin, but not the route that resolves `?w=`.
		const tag = tagFor(
			await asVisitor(EmDashImage, image(key, { src: `/media/${key}` })),
			"elsewhere.jpg",
		);
		expect(attr(tag, "src")).toBe(`/media/${key}`);
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w`);
	});

	it("EmDashImage with nothing stored renders exactly as it does with no database", async () => {
		const key = "2024/05/plain.jpg";
		await seed(key, []);
		const withDatabase = await asVisitor(EmDashImage, image(key));
		expect(withDatabase).toBe(await withNoDatabase(EmDashImage, image(key)));
		expect(withDatabase).not.toMatch(/\?w=\d+/);
	});

	it("a content image with no dimensions offers the stored widths, bounded by the original", async () => {
		const key = "2024/05/content.jpg";
		await seed(key, [
			[300, CURRENT],
			[768, CURRENT],
		]);
		const tag = tagFor(await asVisitor(Image, block(key)), "content.jpg");
		// No display width, so the slot is unknown: stored sizes only, never the original.
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w`);
		expect(attr(tag, "sizes")).toBe("(min-width: 1600px) 1600px, 100vw");
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "loading")).toBe("lazy");
		expect(attr(tag, "width")).toBeUndefined();
		expect(attr(tag, "height")).toBeUndefined();
	});

	it("a photo stored on its side is bounded by its upright width, not its stored one", async () => {
		const key = "2024/05/turned.jpg";
		// The row says 800x400; the picture is 400 wide.
		await seed(key, [[300, CURRENT]], [800, 400], [400, 800]);
		const tag = tagFor(await asVisitor(Image, block(key)), "turned.jpg");
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w`);
		expect(attr(tag, "sizes")).toBe("(min-width: 400px) 400px, 100vw");
	});

	it.each([
		{ kind: "unlinked", link: undefined },
		{ kind: "linked", link: "/photos" },
	])(
		"a $kind resized content image uses auto without changing its candidates",
		async ({ link }) => {
			const key = "2024/05/narrow.jpg";
			await seed(
				key,
				[
					[300, CURRENT],
					[480, CURRENT],
					[768, CURRENT],
					[1024, CURRENT],
					[1536, CURRENT],
					[2048, CURRENT],
				],
				[3200, 1800],
			);
			const html = await asVisitor(
				Image,
				block(key, { displayWidth: 640, width: 3200, height: 1800, link }),
			);
			const tag = tagFor(html, "narrow.jpg");
			if (link) expect(html).toMatch(/<a\b[^>]*\shref="\/photos"[^>]*>\s*<img\b/);
			// Drawn 640 wide: 768 serves an ordinary screen, 1536 a dense one (2 x 640 = 1280).
			expect(attr(tag, "srcset")).toBe(
				[300, 480, 768, 1024, 1536].map((width) => `${FILE}${key}?w=${width} ${width}w`).join(", "),
			);
			expect(attr(tag, "src")).toBe(`${FILE}${key}`);
			expect(attr(tag, "loading")).toBe("lazy");
			expect(attr(tag, "width")).toBe("640");
			expect(attr(tag, "height")).toBe("360");
			expect(attr(tag, "sizes")).toBe("auto, (min-width: 640px) 640px, 100vw");
		},
	);

	it("a small drawing of a large image is offered the smallest stored width, not the original", async () => {
		const key = "2024/05/thumb.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[768, CURRENT],
			],
			[3200, 1800],
		);
		const tag = tagFor(
			await asVisitor(Image, block(key, { displayWidth: 100, width: 3200, height: 1800 })),
			"thumb.jpg",
		);
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w`);
	});

	it("a content image served from a public bucket is still found, and its candidates stay on the file route", async () => {
		const key = "bucket.jpg";
		await seed(key, [[300, CURRENT]]);
		const cdn = (k: string) => `https://cdn.example/${k}`;
		const tag = tagFor(await asVisitor(Image, block(key), cdn), "bucket.jpg");
		expect(attr(tag, "src")).toBe(`https://cdn.example/${key}`);
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w`);
	});

	it("a content image with nothing stored renders exactly as it does with no database", async () => {
		const key = "2024/05/plain-content.jpg";
		await seed(key, []);
		const withDatabase = await asVisitor(Image, block(key));
		expect(withDatabase).toBe(await withNoDatabase(Image, block(key)));
		expect(withDatabase).not.toMatch(/\?w=\d+/);
	});

	it("a read that fails still renders the image, and says so", async () => {
		const key = "2024/05/unreadable.jpg";
		// A database with no schema: the read reaches it and fails.
		const unmigrated = createTestDatabase();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const html = await asVisitor(Image, block(key), undefined, unmigrated);
			expect(html).toBe(await withNoDatabase(Image, block(key)));
			expect(
				warn.mock.calls.some(([message]) => String(message).includes("could not be read")),
			).toBe(true);
		} finally {
			await unmigrated.destroy();
		}
	});

	// The render harness serves the site at this origin.
	const OWN = "https://example.com";
	const ELSEWHERE = "https://elsewhere.example";

	it("an image on another site is never given this site's sizes, even when its key exists here", async () => {
		const key = "shared-key.jpg";
		await seed(key, [
			[300, CURRENT],
			[768, CURRENT],
		]);
		const theirs = `${ELSEWHERE}${FILE}${key}`;
		// The same key, the same path, a different site: its picture is not ours.
		const content = await asVisitor(Image, {
			node: { _type: "image", _key: "f1", asset: { _ref: "ref", url: theirs } },
		});
		expect(attr(tagFor(content, "shared-key.jpg"), "src")).toBe(theirs);
		expect(content).not.toMatch(/\?w=\d+/);
		const inGallery = await asVisitor(Gallery, {
			node: {
				_type: "gallery",
				_key: "f2",
				images: [{ _type: "image", _key: "f3", asset: { _ref: "ref", url: theirs } }],
			},
		});
		expect(attr(tagFor(inGallery, "shared-key.jpg"), "src")).toBe(theirs);
		expect(inGallery).not.toMatch(/\?w=\d+/);
		const cover = await asVisitor(Cover, {
			node: { _type: "cover", _key: "f4", backgroundImage: theirs, content: [] },
		});
		expect(cover).not.toMatch(/\?w=\d+/);
		// A host that merely begins with this site's name is still another site.
		const lookalike = await asVisitor(Image, {
			node: {
				_type: "image",
				_key: "f5",
				asset: { _ref: "ref", url: `${OWN}.evil.test${FILE}${key}` },
			},
		});
		expect(lookalike).not.toMatch(/\?w=\d+/);
		// So is a protocol-relative address.
		const protocolRelative = await asVisitor(Image, {
			node: {
				_type: "image",
				_key: "f6",
				asset: { _ref: "ref", url: `//elsewhere.example${FILE}${key}` },
			},
		});
		expect(protocolRelative).not.toMatch(/\?w=\d+/);
	});

	it("an absolute address on this site's own origin is recognised, query string and all", async () => {
		const key = "own-origin.jpg";
		await seed(key, [[300, CURRENT]]);
		const html = await asVisitor(Image, {
			node: {
				_type: "image",
				_key: "o1",
				asset: { _ref: "ref", url: `${OWN}${FILE}${key}?v=2` },
			},
		});
		expect(attr(tagFor(html, "own-origin.jpg"), "srcset")).toBe(`${FILE}${key}?w=300 300w`);
	});

	const gallery = (keys: string[], extra: Record<string, unknown> = {}) => ({
		node: {
			_type: "gallery",
			_key: "g1",
			columns: 2,
			images: keys.map((key, i) => ({
				_type: "image",
				_key: `g${i}`,
				asset: { _ref: `ref${i}`, url: internalUrl(key) },
				...extra,
			})),
		},
	});

	it("a gallery offers each image's stored widths against its grid cell", async () => {
		const stored = "2024/05/gallery-stored.jpg";
		const bare = "2024/05/gallery-bare.jpg";
		await seed(stored, [
			[300, CURRENT],
			[768, CURRENT],
		]);
		await seed(bare, []);
		const { node } = gallery([stored, bare]);
		node.images = node.images.map((entry, index) =>
			index === 0 ? { ...entry, width: 1600, height: 900 } : entry,
		);
		const html = await asVisitor(Gallery, { node });
		const withSizes = tagFor(html, "gallery-stored.jpg");
		expect(attr(withSizes, "srcset")).toBe(
			`${FILE}${stored}?w=300 300w, ${FILE}${stored}?w=768 768w`,
		);
		// The cell, widened: a square cell covered by a 16:9 picture draws it 1.78 cells wide.
		expect(attr(withSizes, "sizes")).toBe(
			"(max-width: 640px) calc(((100vw - 1rem) / 2) * 1.78), calc(((100vw - 1rem) / 2) * 1.78)",
		);
		expect(attr(withSizes, "src")).toBe(`${FILE}${stored}`);
		expect(attr(withSizes, "loading")).toBe("lazy");
		expect(attr(withSizes, "width")).toBe("1600");
		expect(attr(withSizes, "height")).toBe("900");
		// Its neighbour has nothing stored and is left exactly as it was.
		expect(tagFor(html, "gallery-bare.jpg")).not.toMatch(/\?w=\d+/);
	});

	it("a gallery image with dimensions and stored widths is drawn from them, not by the optimiser", async () => {
		const key = "2024/05/gallery-sized.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[768, CURRENT],
			],
			[1200, 1800],
		);
		const html = await asVisitor(Gallery, gallery([key], { width: 1200, height: 1800 }));
		const tag = tagFor(html, "gallery-sized.jpg");
		// A grid cell's width is a guess, so a gallery offers stored sizes only.
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w`);
		// A portrait fills the cell's width and no more.
		expect(attr(tag, "sizes")).toBe(
			"(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 1rem) / 2)",
		);
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "width")).toBe("1200");
		expect(attr(tag, "height")).toBe("1800");
		expect(attr(tag, "loading")).toBe("lazy");
		// Never wider than the picture is, as before.
		expect(attr(tag, "style")).toContain("max-width: 1200px;");
	});

	it.each([
		{
			name: "a generated hint",
			override: undefined,
			expected: "(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 1rem) / 2)",
		},
		{
			name: "an explicit hint",
			override: "(max-width: 640px) 45vw,  220px",
			expected: "(max-width: 640px) 45vw,  220px",
		},
	])("the square gallery keeps $name unchanged", async ({ override, expected }) => {
		const key = "2024/05/gallery-square.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[768, CURRENT],
				[1024, CURRENT],
			],
			[1200, 1200],
		);
		const html = await asVisitor(Gallery, {
			...gallery([key], { width: 400, height: 400 }),
			...(override === undefined ? {} : { sizes: override }),
		});
		const tag = tagFor(html, key);
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key}?w=1024 1024w`,
		);
		expect(attr(tag, "loading")).toBe("lazy");
		expect(attr(tag, "width")).toBe("400");
		expect(attr(tag, "height")).toBe("400");
		expect(attr(tag, "sizes")).toBe(expected);
	});

	it("a gallery with nothing stored renders exactly as it does with no database", async () => {
		const key = "2024/05/gallery-plain.jpg";
		await seed(key, []);
		const props = gallery([key], { width: 1600, height: 900 });
		const withDatabase = await asVisitor(Gallery, props);
		expect(withDatabase).toBe(await withNoDatabase(Gallery, props));
		expect(withDatabase).not.toMatch(/\?w=\d+/);
	});

	it("Cover offers each stored width for its background image, including the wide rungs", async () => {
		const key = "2024/05/cover.jpg";
		await seed(
			key,
			[
				[480, CURRENT],
				[768, CURRENT],
				[1536, CURRENT],
				[2048, CURRENT],
			],
			[3072, 1728],
		);
		const html = await asVisitor(Cover, {
			node: {
				_type: "cover",
				_key: "c1",
				backgroundImage: `${FILE}${key}`,
				content: [],
				minHeight: "320px",
			},
		});
		const tag = tagFor(html, "cover.jpg");
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=480 480w, ${FILE}${key}?w=768 768w, ${FILE}${key}?w=1536 1536w, ${FILE}${key}?w=2048 2048w`,
		);
		expect(html).toContain('style="min-height: 320px;"');
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "loading")).toBe("lazy");
		expect(attr(tag, "sizes")).toBe("auto, 100vw");
	});

	it("an original wider than every stored size is offered last, at its own width", async () => {
		// Measured in a browser: a 1000 wide cover with sizes stored up to 768 was drawn
		// from the 768 file on a 1440 screen, softer than the page with no stored sizes.
		const key = "2024/05/modest-cover.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[480, CURRENT],
				[768, CURRENT],
			],
			[1000, 750],
		);
		const html = await asVisitor(Cover, {
			node: { _type: "cover", _key: "c2", backgroundImage: `${FILE}${key}`, content: [] },
		});
		const tag = tagFor(html, "modest-cover.jpg");
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=480 480w, ${FILE}${key}?w=768 768w, ${FILE}${key} 1000w`,
		);
	});

	it("a cover's camera original stays out of the list when every size it could have is stored", async () => {
		const key = "2024/05/camera.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[480, CURRENT],
				[768, CURRENT],
				[1024, CURRENT],
				[1536, CURRENT],
				[2048, CURRENT],
			],
			[4032, 3024],
		);
		const tag = tagFor(
			await asVisitor(Cover, {
				node: { _type: "cover", _key: "c3", backgroundImage: `${FILE}${key}`, content: [] },
			}),
			"camera.jpg",
		);
		const offered = (attr(tag, "srcset") ?? "").split(", ");
		expect(offered.map((c) => c.split(" ")[1])).toEqual([
			"300w",
			"480w",
			"768w",
			"1024w",
			"1536w",
			"2048w",
		]);
		expect(offered.every((c) => /\?w=\d+ /.test(c))).toBe(true);
	});

	it("a cover's camera original is offered when the store is missing the sizes above the last one", async () => {
		const key = "2024/05/camera-partial.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[768, CURRENT],
			],
			[4032, 3024],
		);
		const tag = tagFor(
			await asVisitor(Cover, {
				node: { _type: "cover", _key: "c4", backgroundImage: `${FILE}${key}`, content: [] },
			}),
			"camera-partial.jpg",
		);
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key} 4032w`,
		);
	});

	it("a cover photographed on its side offers its original at the upright width", async () => {
		const key = "2024/05/turned-original.jpg";
		// The row says 1200x900; the picture a browser draws is 900 wide.
		await seed(
			key,
			[
				[300, CURRENT],
				[768, CURRENT],
			],
			[1200, 900],
			[900, 1200],
		);
		const tag = tagFor(
			await asVisitor(Cover, {
				node: { _type: "cover", _key: "c5", backgroundImage: `${FILE}${key}`, content: [] },
			}),
			"turned-original.jpg",
		);
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key} 900w`,
		);
	});

	it("a cover's original of exactly 2560 joins a full set of stored sizes, and one of 2561 does not", async () => {
		const ladder: Array<[number, string]> = [
			[300, CURRENT],
			[480, CURRENT],
			[768, CURRENT],
			[1024, CURRENT],
			[1536, CURRENT],
			[2048, CURRENT],
		];
		const atCap = "2024/05/at-cap.jpg";
		const pastCap = "2024/05/past-cap.jpg";
		await seed(atCap, ladder, [2560, 1440]);
		await seed(pastCap, ladder, [2561, 1441]);
		const at = tagFor(
			await asVisitor(Cover, {
				node: { _type: "cover", _key: "c6", backgroundImage: `${FILE}${atCap}`, content: [] },
			}),
			"at-cap.jpg",
		);
		expect(attr(at, "srcset")?.split(", ").at(-1)).toBe(`${FILE}${atCap} 2560w`);
		const past = tagFor(
			await asVisitor(Cover, {
				node: { _type: "cover", _key: "c7", backgroundImage: `${FILE}${pastCap}`, content: [] },
			}),
			"past-cap.jpg",
		);
		expect(attr(past, "srcset")?.split(", ").at(-1)).toBe(`${FILE}${pastCap}?w=2048 2048w`);
	});

	it("an event card on a camera original with short stored sizes is offered those sizes and never the original", async () => {
		// Measured in a browser: a card drawn about 350 wide declares
		// `(min-width: 6000px) 6000px, 100vw`, so a 1440 screen wants 1440 px. Given the
		// original as a candidate it fetched the 9.5 MB camera file in place of the
		// 102 KB 768 file. A card does not know its slot, so it is never offered.
		const key = "2024/05/event-card.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[480, CURRENT],
				[768, CURRENT],
			],
			[6000, 4000],
		);
		const tag = tagFor(
			await asVisitor(EmDashImage, image(key, { width: 6000, height: 4000 })),
			"event-card.jpg",
		);
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 6000px) 6000px, 100vw");
		const offered = (attr(tag, "srcset") ?? "").split(", ");
		expect(offered).toEqual([
			`${FILE}${key}?w=300 300w`,
			`${FILE}${key}?w=480 480w`,
			`${FILE}${key}?w=768 768w`,
		]);
		expect(offered.some((c) => c.startsWith(`${FILE}${key} `))).toBe(false);
	});

	it("an image an editor gave a display width knows its slot, so its original closes a short list", async () => {
		const key = "2024/05/display-width.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[480, CURRENT],
				[768, CURRENT],
			],
			[1000, 750],
		);
		const tag = tagFor(
			await asVisitor(Image, block(key, { displayWidth: 900, width: 1000, height: 750 })),
			"display-width.jpg",
		);
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=480 480w, ${FILE}${key}?w=768 768w, ${FILE}${key} 1000w`,
		);
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 900px) 900px, 100vw");
	});
});
