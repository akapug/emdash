/**
 * COMPLETING A ROW A CUT LEFT HALF-WRITTEN — and never touching one it did not.
 *
 * A post's content row is written in one transaction; its taxonomy assignments are
 * a SECOND write after it. A request cut between the two leaves a row with no
 * pivots, and `skipExisting` would skip it forever: the entry is there, its
 * categories are not, and no report says so. MEASURED 2026-11-24: 156 of 190 rows
 * in after two cut attempts, media 0, `/pages/upcoming` drawing one card.
 *
 * `completeOnly` names the keys the HOST's own earlier attempt saw no row at, so
 * those rows may be finished. Everything else on the site belongs to somebody else
 * — the owner's edits, an earlier import — and a re-import must never write over it.
 *
 * Three arms, one per rule:
 * 1. an owner-changed row NOT in the list keeps its taxonomy;
 * 2. a listed row holding one of two categories ends with both (replace converges);
 * 3. a listed scheduled row gets its moment.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importContent, type ImportConfig } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import type { Database } from "../../../src/database/types.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function item(opts: { id: number; slug: string; status?: string; postDateGmt?: string; categories?: string[] }): string {
	return `
    <item>
      <title><![CDATA[${opts.slug}]]></title>
      <link>https://example.org/${opts.slug}/</link>
      ${(opts.categories ?? []).map((c) => `<category domain="category" nicename="${c}"><![CDATA[${c}]]></category>`).join("\n      ")}
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[<p>Body of ${opts.slug}.</p>]]></content:encoded>
      <wp:post_id>${opts.id}</wp:post_id>
      <wp:post_date><![CDATA[2020-01-01 00:00:00]]></wp:post_date>
      ${opts.postDateGmt !== undefined ? `<wp:post_date_gmt><![CDATA[${opts.postDateGmt}]]></wp:post_date_gmt>` : ""}
      <wp:post_name><![CDATA[${opts.slug}]]></wp:post_name>
      <wp:status><![CDATA[${opts.status ?? "publish"}]]></wp:status>
      <wp:post_type><![CDATA[post]]></wp:post_type>
    </item>`;
}

function wrapWxr(items: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Complete</title>
    <link>https://example.org</link>
    ${items.join("\n")}
  </channel>
</rss>`;
}

describe("WXR import: completeOnly finishes only the rows this run cut", () => {
	let db: Kysely<Database>;
	let emdash: EmDashHandlers;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "content", label: "Content", type: "portableText" });
		await registry.createField("posts", { slug: "excerpt", label: "Excerpt", type: "text" });
		emdash = handlersFromRuntime(createTestRuntime(db));
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function runImport(xml: string, completeOnly?: string[]) {
		const wxr = await parseWxrString(xml);
		const plan = await preImportWxrTaxonomies(db, wxr.posts, wxr.categories, wxr.tags, wxr.terms);
		const config: ImportConfig = {
			postTypeMappings: { post: { collection: "posts", enabled: true } },
			skipExisting: true,
			...(completeOnly ? { completeOnly } : {}),
		};
		return importContent(wxr.posts, config, emdash, await emdash.getManifest(), new Map(), undefined, undefined, plan, undefined, wxr.site.language);
	}

	/** The taxonomy names attached to a slug, read from the pivot. */
	async function taxonomiesOf(slug: string): Promise<string[]> {
		const row = await db.selectFrom("posts").select(["id"]).where("slug", "=", slug).executeTakeFirstOrThrow();
		const rows = await db
			.selectFrom("_emdash_content_taxonomies" as never)
			.select(["taxonomy", "term"] as never)
			.where("content_id" as never, "=", row.id as never)
			.execute() as unknown as Array<{ taxonomy: string; term: string }>;
		return rows.map((r) => `${r.taxonomy}:${r.term}`).sort();
	}

	it("AN OWNER-CHANGED ROW NOT IN THE LIST KEEPS ITS TAXONOMY", async () => {
		// First import: the row and its category land.
		await runImport(wrapWxr([item({ id: 1, slug: "owned", categories: ["original"] })]));
		expect(await taxonomiesOf("owned")).toEqual(["category:original"]);

		// The owner re-files it by hand: this row now belongs to THEM.
		const row = await db.selectFrom("posts").select(["id"]).where("slug", "=", "owned").executeTakeFirstOrThrow();
		await db.deleteFrom("_emdash_content_taxonomies" as never).where("content_id" as never, "=", row.id as never).execute();
		await db
			.insertInto("_emdash_content_taxonomies" as never)
			.values({ content_id: row.id, taxonomy: "category", term: "owner-choice" } as never)
			.execute();

		// Re-import WITHOUT naming it: the WXR says "different", the owner said "owner-choice".
		await runImport(wrapWxr([item({ id: 1, slug: "owned", categories: ["different"] })]));
		expect(await taxonomiesOf("owned"), "the owner's choice stands — this import did not write over it").toEqual(["category:owner-choice"]);
	});

	it("A LISTED ROW HOLDING ONE OF TWO CATEGORIES ENDS WITH BOTH", async () => {
		await runImport(wrapWxr([item({ id: 1, slug: "cut", categories: ["first"] })]));
		expect(await taxonomiesOf("cut")).toEqual(["category:first"]);

		// The WXR declares two; the cut left only one. NAMED by the host, so it is ours
		// to finish: replace converges on the file's full set.
		const result = await runImport(
			wrapWxr([item({ id: 1, slug: "cut", categories: ["first", "second"] })]),
			["posts cut (unknown)", "posts cut en"],
		);
		expect(await taxonomiesOf("cut"), "the row ends with the file's whole set").toEqual(["category:first", "category:second"]);
		expect(result.completed ?? [], "and the run says which rows it completed").toContain("posts cut");
	});

	it("A LISTED SCHEDULED ROW GETS ITS MOMENT", async () => {
		await runImport(wrapWxr([item({ id: 1, slug: "later", status: "future", postDateGmt: "2099-05-01 10:00:00" })]));
		// A cut left it a real draft with no moment.
		await db.updateTable("posts").set({ status: "draft", scheduled_at: null } as never).where("slug", "=", "later").execute();

		await runImport(
			wrapWxr([item({ id: 1, slug: "later", status: "future", postDateGmt: "2099-05-01 10:00:00" })]),
			["posts later (unknown)", "posts later en"],
		);
		const row = await db.selectFrom("posts").select(["status", "scheduled_at"]).where("slug", "=", "later").executeTakeFirstOrThrow();
		expect(row.status, "the moment landed and the row is scheduled").toBe("scheduled");
		expect(row.scheduled_at, "with the WXR's own time").not.toBeNull();
	});
});
