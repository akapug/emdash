/**
 * The WXR execute import stores a post's title, excerpt and content as
 * WordPress printed them (wptexturize: curly quotes, dashes, an ellipsis),
 * and makes the slug from the title as it was stored.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	importContent,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import type { Database } from "../../../src/database/types.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { slugify } from "../../../src/utils/slugify.js";
import { handlersFromRuntime, createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/">
  <channel>
    <title>Example Garden</title>
    <link>https://example.org</link>
    <item>
      <title><![CDATA[Tom's "Big" Day -- Live...]]></title>
      <link>https://example.org/?p=7</link>
      <wp:post_id>7</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <excerpt:encoded><![CDATA[It's "short" - really.]]></excerpt:encoded>
      <content:encoded><![CDATA[<p>It's "here" - now...</p><pre>"raw" --</pre>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const CONFIG: ImportConfig = {
	postTypeMappings: { post: { collection: "posts", enabled: true } },
	skipExisting: true,
};

interface Harness {
	db: Kysely<Database>;
	emdash: EmDashHandlers;
	manifest: EmDashManifest;
}

async function setup(): Promise<Harness> {
	const db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		urlPattern: "/posts/{slug}",
	});
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
	await registry.createField("posts", { slug: "content", label: "Content", type: "portableText" });
	await registry.createField("posts", { slug: "excerpt", label: "Excerpt", type: "text" });
	const emdash = handlersFromRuntime(createTestRuntime(db));
	return { db, emdash, manifest: await emdash.getManifest() };
}

/** The WXR with a `<language>` of its own. */
const inLanguage = (language: string) =>
	WXR.replace(
		"<link>https://example.org</link>",
		`<link>https://example.org</link>\n    <language>${language}</language>`,
	);

describe("WXR import: the text as WordPress printed it", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await setup();
	});

	afterEach(async () => {
		await teardownTestDatabase(harness.db);
	});

	it("curls the title, the excerpt and the content, and makes the slug from the stored title", async () => {
		const wxr = await parseWxrString(WXR);
		const plan = await preImportWxrTaxonomies(
			harness.db,
			wxr.posts,
			wxr.categories,
			wxr.tags,
			wxr.terms,
		);
		const result = await importContent(
			wxr.posts,
			CONFIG,
			harness.emdash,
			harness.manifest,
			new Map(),
			undefined,
			undefined,
			plan,
		);
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);

		const row = (await harness.db
			.selectFrom("ec_posts" as keyof Database)
			.selectAll()
			.executeTakeFirstOrThrow()) as unknown as {
			slug: string;
			title: string;
			excerpt: string;
			content: string;
		};
		expect(row.title).toBe("Tom’s “Big” Day — Live…");
		expect(row.excerpt).toBe("It’s “short” – really.");
		expect(row.slug).toBe(slugify(`Tom's "Big" Day -- Live...`));
		const blocks = JSON.parse(row.content) as Array<{
			_type: string;
			children?: Array<{ text: string }>;
			code?: string;
		}>;
		expect(
			blocks.map((b) => (b._type === "code" ? b.code : b.children?.map((c) => c.text).join(""))),
		).toEqual(["It’s “here” – now…", '"raw" --']);
		expect(result.typography).toEqual({
			language: null,
			texturized: true,
			note: "the export names no language: the text is stored as WordPress printed it in English (wptexturize)",
		});
	});

	it("stores a site in another language as written, and says so; an English one as WordPress printed it", async () => {
		const run = async (language: string) => {
			const wxr = await parseWxrString(inLanguage(language));
			const plan = await preImportWxrTaxonomies(
				harness.db,
				wxr.posts,
				wxr.categories,
				wxr.tags,
				wxr.terms,
			);
			const result = await importContent(
				wxr.posts,
				{ ...CONFIG, skipExisting: false },
				harness.emdash,
				harness.manifest,
				new Map(),
				undefined,
				undefined,
				plan,
				undefined,
				wxr.site.language,
			);
			const rows = (await harness.db
				.selectFrom("ec_posts" as keyof Database)
				.selectAll()
				.execute()) as unknown as Array<{ title: string; excerpt: string; content: string }>;
			const row = rows.at(-1)!;
			const first = (JSON.parse(row.content) as Array<{ children?: Array<{ text: string }> }>)[0]!;
			return {
				result,
				said: [row.title, row.excerpt, first.children?.map((c) => c.text).join("")],
			};
		};
		const fr = await run("fr-FR");
		expect(fr.said).toEqual([
			`Tom's "Big" Day -- Live...`,
			`It's "short" - really.`,
			`It's "here" - now...`,
		]);
		expect(fr.result.typography).toMatchObject({ language: "fr-FR", texturized: false });
		expect(fr.result.typography!.note).toContain("stored as written");
		await teardownTestDatabase(harness.db);
		harness = await setup();
		const en = await run("en-GB");
		expect(en.said).toEqual([
			"Tom’s “Big” Day — Live…",
			"It’s “short” – really.",
			"It’s “here” – now…",
		]);
		expect(en.result.typography).toMatchObject({ language: "en-GB", texturized: true });
	});

	it("reads the language in the WXR source too, and says which in its analysis", async () => {
		const { wxrSource } = await import("../../../src/import/sources/wxr.js");
		const file = (xml: string) => ({
			type: "file" as const,
			file: new File([xml], "export.xml", { type: "text/xml" }),
		});
		const items = async (xml: string) => {
			const out = [];
			for await (const item of wxrSource.fetchContent(file(xml), { postTypes: ["post"] }))
				out.push(item);
			return out;
		};
		expect((await items(inLanguage("de-DE")))[0]!.title).toBe(`Tom's "Big" Day -- Live...`);
		expect((await items(WXR))[0]!.title).toBe("Tom’s “Big” Day — Live…");
		const analysis = await wxrSource.analyze(file(inLanguage("de-DE")), {});
		expect(analysis.typography).toMatchObject({ language: "de-DE", texturized: false });
	});
});
