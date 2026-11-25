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
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

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
		const parent = await new MediaRepository(db).create({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
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
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=1024 1024w, ${FILE}${key} 1600w`,
		);
		expect(attr(tag, "sizes")).toBe("(min-width: 1600px) 1600px, 100vw");
		// The fallback is the original, and the layout attributes are kept.
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "width")).toBe("1600");
		expect(attr(tag, "height")).toBe("900");
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
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key} 1600w`);
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
		// The 1600 wide original closes the list: 768 alone would be stretched on a wide screen.
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key} 1600w`,
		);
		expect(attr(tag, "sizes")).toBe("(min-width: 1600px) 1600px, 100vw");
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
	});

	it("a photo stored on its side is bounded by its upright width, not its stored one", async () => {
		const key = "2024/05/turned.jpg";
		// The row says 800x400; the picture is 400 wide.
		await seed(key, [[300, CURRENT]], [800, 400], [400, 800]);
		const tag = tagFor(await asVisitor(Image, block(key)), "turned.jpg");
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key} 400w`);
		expect(attr(tag, "sizes")).toBe("(min-width: 400px) 400px, 100vw");
	});

	it("a content image resized smaller is offered enough for a dense screen, and no more", async () => {
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
		const tag = tagFor(
			await asVisitor(Image, block(key, { displayWidth: 640, width: 3200, height: 1800 })),
			"narrow.jpg",
		);
		// Drawn 640 wide: 768 serves an ordinary screen, 1536 a dense one (2 x 640 = 1280).
		// 480 alone would be softer than the original; 2048 is never the right choice here.
		const offered = (attr(tag, "srcset") ?? "").split(", ").map((c) => c.split(" ")[1]);
		expect(offered).toEqual(["300w", "480w", "768w", "1024w", "1536w"]);
		expect(attr(tag, "sizes")).toBe("(min-width: 640px) 640px, 100vw");
		expect(attr(tag, "width")).toBe("640");
	});

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
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key} 1600w`);
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
		expect(attr(tagFor(html, "own-origin.jpg"), "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key} 1600w`,
		);
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
		const html = await asVisitor(Gallery, gallery([stored, bare]));
		const withSizes = tagFor(html, "gallery-stored.jpg");
		expect(attr(withSizes, "srcset")).toBe(
			`${FILE}${stored}?w=300 300w, ${FILE}${stored}?w=768 768w, ${FILE}${stored} 1600w`,
		);
		// The cell, widened: a square cell covered by a 16:9 picture draws it 1.78 cells wide.
		expect(attr(withSizes, "sizes")).toBe(
			"(max-width: 640px) calc(((100vw - 1rem) / 2) * 1.78), calc(((100vw - 1rem) / 2) * 1.78)",
		);
		expect(attr(withSizes, "src")).toBe(`${FILE}${stored}`);
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
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key} 1200w`,
		);
		// A portrait fills the cell's width and no more.
		expect(attr(tag, "sizes")).toBe(
			"(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 1rem) / 2)",
		);
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
		expect(attr(tag, "width")).toBe("1200");
		// Never wider than the picture is, as before.
		expect(attr(tag, "style")).toContain("max-width: 1200px;");
	});

	it("a gallery's own sizes value is used as given", async () => {
		const key = "2024/05/gallery-override.jpg";
		await seed(key, [[300, CURRENT]]);
		const html = await asVisitor(Gallery, { ...gallery([key]), sizes: "220px" });
		expect(attr(tagFor(html, "gallery-override.jpg"), "sizes")).toBe("220px");
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
			node: { _type: "cover", _key: "c1", backgroundImage: `${FILE}${key}`, content: [] },
		});
		const tag = tagFor(html, "cover.jpg");
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=480 480w, ${FILE}${key}?w=768 768w, ${FILE}${key}?w=1536 1536w, ${FILE}${key}?w=2048 2048w`,
		);
		expect(attr(tag, "sizes")).toBe("100vw");
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
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

	it("a camera original stays out of the list when every size it could have is stored", async () => {
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
		const tag = tagFor(await asVisitor(Image, block(key)), "camera.jpg");
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

	it("a camera original is offered when the store is missing the sizes above the last one", async () => {
		const key = "2024/05/camera-partial.jpg";
		await seed(
			key,
			[
				[300, CURRENT],
				[768, CURRENT],
			],
			[4032, 3024],
		);
		const tag = tagFor(await asVisitor(Image, block(key)), "camera-partial.jpg");
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key} 4032w`,
		);
	});

	it("a photo stored on its side offers its original at the upright width", async () => {
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
		const tag = tagFor(await asVisitor(Image, block(key)), "turned-original.jpg");
		expect(attr(tag, "srcset")).toBe(
			`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w, ${FILE}${key} 900w`,
		);
	});

	it("an original of exactly 2560 joins a full set of stored sizes, and one of 2561 does not", async () => {
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
		const at = tagFor(await asVisitor(Image, block(atCap)), "at-cap.jpg");
		expect(attr(at, "srcset")?.split(", ").at(-1)).toBe(`${FILE}${atCap} 2560w`);
		const past = tagFor(await asVisitor(Image, block(pastCap)), "past-cap.jpg");
		expect(attr(past, "srcset")?.split(", ").at(-1)).toBe(`${FILE}${pastCap}?w=2048 2048w`);
	});
});
