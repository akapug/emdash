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
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key}?w=1024 1024w`);
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
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w, ${FILE}${key}?w=768 768w`);
		expect(attr(tag, "sizes")).toBe("(min-width: 1600px) 1600px, 100vw");
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
	});

	it("a photo stored on its side is bounded by its upright width, not its stored one", async () => {
		const key = "2024/05/turned.jpg";
		// The row says 800x400; the picture is 400 wide. 600 is not narrower than that.
		await seed(
			key,
			[
				[300, CURRENT],
				[600, CURRENT],
			],
			[800, 400],
			[400, 800],
		);
		const tag = tagFor(await asVisitor(Image, block(key)), "turned.jpg");
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w`);
		expect(attr(tag, "sizes")).toBe("(min-width: 400px) 400px, 100vw");
	});

	it("a content image drawn narrower than a stored width does not offer that width", async () => {
		const key = "2024/05/narrow.jpg";
		await seed(key, [
			[300, CURRENT],
			[768, CURRENT],
		]);
		const tag = tagFor(
			await asVisitor(Image, block(key, { displayWidth: 640, width: 1600, height: 900 })),
			"narrow.jpg",
		);
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=300 300w`);
		expect(attr(tag, "sizes")).toBe("(min-width: 640px) 640px, 100vw");
		expect(attr(tag, "width")).toBe("640");
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

	it("Cover offers each stored width for its background image", async () => {
		const key = "2024/05/cover.jpg";
		await seed(key, [
			[480, CURRENT],
			[768, CURRENT],
		]);
		const html = await asVisitor(Cover, {
			node: { _type: "cover", _key: "c1", backgroundImage: `${FILE}${key}`, content: [] },
		});
		const tag = tagFor(html, "cover.jpg");
		expect(attr(tag, "srcset")).toBe(`${FILE}${key}?w=480 480w, ${FILE}${key}?w=768 768w`);
		expect(attr(tag, "sizes")).toBe("100vw");
		expect(attr(tag, "src")).toBe(`${FILE}${key}`);
	});
});
