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
	});
});
