/**
 * A WXR post's featured image, through the import as the admin wizard (and
 * any client of the import routes) drives it: execute stores the
 * attachment's URL, the media step stores the file and maps that URL to the
 * file's local one, and the rewrite step points the post at it. The post
 * ends holding the local media item, with the size read from the file, so a
 * template can draw it at its own size.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { PNG } = vi.hoisted(() => {
	// A real 1237 x 16 PNG (black, RGB), built by hand: one stored deflate block.
	const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
	const crc32 = (bytes: Iterable<number>) => {
		let c = ~0;
		for (const b of bytes) {
			c ^= b;
			for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		}
		return ~c >>> 0;
	};
	const adler32 = (bytes: Iterable<number>) => {
		let a = 1;
		let b = 0;
		for (const x of bytes) {
			a = (a + x) % 65521;
			b = (b + a) % 65521;
		}
		return ((b << 16) | a) >>> 0;
	};
	const chunk = (type: string, data: number[]) => {
		const head = Array.from(type, (c) => c.charCodeAt(0));
		return [...u32(data.length), ...head, ...data, ...u32(crc32([...head, ...data]))];
	};
	const [width, height] = [1237, 16];
	// Each row: filter 0, then black pixels.
	const raw = new Uint8Array(height * (1 + width * 3));
	const n = raw.length;
	const idat = [0x78, 0x01, 0x01, n & 255, n >>> 8, ~n & 255, (~n >>> 8) & 255, ...raw];
	return {
		PNG: new Uint8Array([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a,
			...chunk("IHDR", [...u32(width), ...u32(height), 8, 2, 0, 0, 0]),
			...chunk("IDAT", [...idat, ...u32(adler32(raw))]),
			...chunk("IEND", []),
		]),
	};
});

// The media step downloads each attachment from the source site: stub the fetch.
vi.mock("#import/ssrf.js", () => ({
	validateExternalUrl: () => {},
	SsrfError: class SsrfError extends Error {},
	ssrfSafeFetch: async () =>
		new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
}));

import {
	importContent,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { importMediaWithProgress } from "../../../src/astro/routes/api/import/wordpress/media.js";
import { rewriteUrls } from "../../../src/astro/routes/api/import/wordpress/rewrite-urls.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { Storage } from "../../../src/storage/types.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const IMAGE = "https://example.org/wp-content/uploads/2026/01/hero.png";

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Garden</title>
    <link>https://example.org</link>
    <item>
      <title>hero.png</title>
      <wp:post_id>100</wp:post_id>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
      <wp:attachment_url>${IMAGE}</wp:attachment_url>
    </item>
    <item>
      <title>The Pond</title>
      <link>https://example.org/the-pond/</link>
      <dc:creator><![CDATA[pat]]></dc:creator>
      <wp:post_id>7</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-15 08:30:00]]></wp:post_date_gmt>
      <wp:post_name><![CDATA[the-pond]]></wp:post_name>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <content:encoded><![CDATA[<p>Still water.</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value><![CDATA[100]]></wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;

const CONFIG: ImportConfig = {
	postTypeMappings: { post: { collection: "posts", enabled: true } },
	skipExisting: false,
};

function fakeStorage(): Storage {
	return {
		async upload(o) {
			const b = o.body instanceof Uint8Array ? o.body : new Uint8Array(o.body as ArrayBuffer);
			return { key: o.key, url: `/m/${o.key}`, size: b.byteLength };
		},
	} as Storage;
}

describe("WXR import: a post's featured image", () => {
	let db: Kysely<Database>;
	let emdash: EmDashHandlers;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("posts", { slug: "excerpt", label: "Excerpt", type: "text" });
		await registry.createField("posts", {
			slug: "featured_image",
			label: "Featured Image",
			type: "image",
		});
		const runtime = createTestRuntime(db);
		// The local provider, as the runtime registers it by default.
		runtime.mediaProviders.set("local", createMediaProvider({ db }));
		emdash = handlersFromRuntime(runtime);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	const featured = async () => {
		const row = await db
			.selectFrom("ec_posts" as keyof Database)
			.select("featured_image" as never)
			.where("slug" as never, "=", "the-pond" as never)
			.executeTakeFirstOrThrow();
		return JSON.parse((row as { featured_image: string }).featured_image) as unknown;
	};

	it("ends holding the local media item: its id, the file's size and its storage key", async () => {
		const wxr = await parseWxrString(WXR);
		const plan = await preImportWxrTaxonomies(db, wxr.posts, wxr.categories, wxr.tags, wxr.terms);
		const attachments = new Map(
			wxr.attachments.map((a): [string, string] => [String(a.id), a.url ?? ""]),
		);
		const imported = await importContent(
			wxr.posts,
			CONFIG,
			emdash,
			await emdash.getManifest(),
			attachments,
			undefined,
			undefined,
			plan,
		);
		expect(imported.errors).toEqual([]);
		expect(imported.imported).toBe(1);
		// Execute stores the attachment's own URL.
		expect(await featured()).toEqual({ provider: "external", id: "", src: IMAGE });

		const media = await importMediaWithProgress(
			wxr.attachments.map((a) => ({
				id: a.id,
				url: a.url,
				filename: "hero.png",
				mimeType: "image/png",
			})),
			db,
			fakeStorage(),
			() => {},
		);
		expect(media.failed).toEqual([]);
		const item = await new MediaRepository(db).findById(media.imported[0]!.mediaId);
		expect(item).toMatchObject({ width: 1237, height: 16 });
		expect(media.urlMap[IMAGE]).toBe(`/_emdash/api/media/file/${item!.storageKey}`);

		const rewrite = await rewriteUrls(db, media.urlMap, (id) => emdash.getMediaProvider(id));
		expect(rewrite.errors).toEqual([]);
		expect(rewrite.updated).toBe(1);

		expect(await featured()).toEqual({
			provider: "local",
			id: item!.id,
			filename: "hero.png",
			mimeType: "image/png",
			width: 1237,
			height: 16,
			...(item!.blurhash ? { blurhash: item!.blurhash } : {}),
			...(item!.dominantColor ? { dominantColor: item!.dominantColor } : {}),
			meta: {
				storageKey: item!.storageKey,
				caption: null,
				blurhash: item!.blurhash,
				dominantColor: item!.dominantColor,
			},
		});
	});
});
