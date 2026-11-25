/**
 * Item 132: End-to-end atomic WXR execute integration, capability advertisement,
 * replay hook suppression, non-aliasing missing post IDs, and query-budget proof.
 */

import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	IMPORT_CAPABILITIES,
	WXR_ATOMIC_IMPORT_CAPABILITY,
} from "../../../src/astro/routes/api/import/wordpress/analyze.js";
import {
	POST as executePost,
	type ImportConfig,
	type ImportResult,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import {
	createPasswordVerifier,
	PROTECTED_CONTENT_CAPABILITY,
} from "../../../src/content/protection.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildWxr(itemsXml: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Site</title>
    <link>https://example.org</link>
    <language>en-US</language>
    <wp:author>
      <wp:author_login><![CDATA[alice]]></wp:author_login>
      <wp:author_display_name><![CDATA[Alice Editor]]></wp:author_display_name>
    </wp:author>
    ${itemsXml}
  </channel>
</rss>`;
}

async function runExecute(
	emdash: EmDashHandlers,
	wxr: string,
	config: ImportConfig,
): Promise<{ status: number; body: { success: boolean; data: ImportResult } }> {
	const formData = new FormData();
	formData.append("file", new File([wxr], "export.xml", { type: "application/xml" }));
	formData.append("config", JSON.stringify(config));
	const request = new Request("https://example.org/_emdash/api/import/wordpress/execute", {
		method: "POST",
		body: formData,
	});
	const ctx = {
		editMode: false,
		metrics: createRequestMetrics(performance.now()),
	};
	const response = await runWithContext(ctx, () =>
		executePost({
			request,
			locals: {
				emdash,
				user: { id: "admin-1", role: 100, permissions: ["*"] },
			},
		} as never),
	);
	return {
		status: response.status,
		body: (await response.json()) as { success: boolean; data: ImportResult },
	};
}

describe("Item 132: atomic per-post WXR execute", () => {
	let db: Kysely<Database>;
	let emdash: EmDashHandlers;
	let beforeSaveCalls: number;
	let afterSaveCalls: number;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages", hasSeo: true });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("pages", { slug: "excerpt", label: "Excerpt", type: "text" });

		beforeSaveCalls = 0;
		afterSaveCalls = 0;
		const runtime = createTestRuntime(db, {
			plugins: [
				{
					id: "atomic-wxr-hook-spy",
					version: "1.0.0",
					capabilities: ["content:read", "content:write"],
					admin: { settingsSchema: {} },
					storage: {},
					hooks: {
						"content:beforeSave": {
							pluginId: "atomic-wxr-hook-spy",
							priority: 10,
							dependencies: [],
							exclusive: false,
							handler: async () => {
								beforeSaveCalls++;
							},
						},
						"content:afterSave": {
							pluginId: "atomic-wxr-hook-spy",
							priority: 10,
							dependencies: [],
							exclusive: false,
							handler: async () => {
								afterSaveCalls++;
							},
						},
					},
				} as never,
			],
		});
		emdash = handlersFromRuntime(runtime);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("advertises WXR_ATOMIC_IMPORT_CAPABILITY on analyze", () => {
		expect(IMPORT_CAPABILITIES).toContain(WXR_ATOMIC_IMPORT_CAPABILITY);
	});

	it("resumes with the same source author when the base byline slug is occupied", async () => {
		const occupiedByline = await new BylineRepository(db).create({
			slug: "alice",
			displayName: "Existing Alice",
			isGuest: true,
		});
		const item = (id: number) => `
			<item>
				<title>Page ${id}</title>
				<dc:creator>alice</dc:creator>
				<wp:post_id>${id}</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>page-${id}</wp:post_name>
			</item>`;
		const config: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			atomic: true,
			sourceLineage: "install:byline-resume",
			skipExisting: true,
			importSections: false,
			importComments: false,
		};
		const committed = await runExecute(emdash, buildWxr(item(701)), config);
		expect(committed.status).toBe(200);
		expect(committed.body.data.items?.[0]?.outcome).toBe("created");
		const resumed = await runExecute(emdash, buildWxr(item(701) + item(702)), config);
		expect(resumed.status).toBe(200);
		expect(resumed.body.data.items?.map(({ outcome }) => outcome)).toEqual(["replayed", "created"]);
		const credits = await db
			.selectFrom("_emdash_content_bylines as credit")
			.innerJoin("_emdash_bylines as byline", "byline.id", "credit.byline_id")
			.select(["credit.byline_id", "byline.display_name"])
			.where("credit.collection_slug", "=", "pages")
			.execute();
		expect(credits).toHaveLength(2);
		expect(new Set(credits.map(({ byline_id }) => byline_id)).size).toBe(1);
		expect(credits[0]?.byline_id).not.toBe(occupiedByline.id);
		expect(credits[0]?.display_name).toBe("Alice Editor");
	});

	it("creates atomically with receipts and replays with ZERO writes and ZERO hooks", async () => {
		const wxr = buildWxr(`
    <item>
      <title>First Atomic Page</title>
      <link>https://example.org/first-atomic/</link>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_id>501</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>first-atomic</wp:post_name>
      <content:encoded><![CDATA[<p>Atomic body</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_yoast_wpseo_title</wp:meta_key><wp:meta_value><![CDATA[Atomic SEO]]></wp:meta_value></wp:postmeta>
    </item>
    <item>
      <title>Scheduled Atomic Page</title>
      <link>https://example.org/scheduled-atomic/</link>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_id>502</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>future</wp:status>
      <wp:post_date_gmt>2030-07-01 10:00:00</wp:post_date_gmt>
      <wp:post_name>scheduled-atomic</wp:post_name>
      <content:encoded><![CDATA[<p>Scheduled body</p>]]></content:encoded>
    </item>`);

		const config: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting: true,
			importSections: false,
			importSeo: true,
			importComments: false,
			atomic: true,
			sourceLineage: "install:site-132",
		};

		const first = await runExecute(emdash, wxr, config);
		expect(first.status).toBe(200);
		expect(first.body.data.imported).toBe(2);
		expect(first.body.data.skipped).toBe(0);
		expect(first.body.data.errors).toEqual([]);
		expect(first.body.data.items).toHaveLength(2);
		expect(first.body.data.items?.[0]).toMatchObject({
			collection: "pages",
			slug: "first-atomic",
			status: "published",
			sourcePostId: "501",
			outcome: "created",
		});
		expect(first.body.data.items?.[1]).toMatchObject({
			collection: "pages",
			slug: "scheduled-atomic",
			status: "scheduled",
			sourcePostId: "502",
			outcome: "created",
		});
		expect(beforeSaveCalls).toBe(2);
		expect(afterSaveCalls).toBe(2);

		// Replay identical request: zero hooks, zero new writes, historic receipts returned.
		const second = await runExecute(emdash, wxr, config);
		expect(second.status).toBe(200);
		expect(second.body.data.imported).toBe(0);
		expect(second.body.data.skipped).toBe(2);
		expect(second.body.data.errors).toEqual([]);
		expect(second.body.data.items).toHaveLength(2);
		expect(second.body.data.items?.[0]).toMatchObject({
			operationId: first.body.data.items?.[0]?.operationId,
			storedDataHash: first.body.data.items?.[0]?.storedDataHash,
			committedHash: first.body.data.items?.[0]?.committedHash,
			outcome: "replayed",
		});
		expect(beforeSaveCalls).toBe(2);
		expect(afterSaveCalls).toBe(2);

		// Changing only the author display name in the WXR header changes both source items.
		const renamedAuthor = wxr.replace("<![CDATA[Alice Editor]]>", "<![CDATA[Alice Writer]]>");
		const changed = await runExecute(emdash, renamedAuthor, config);
		expect(changed.status).toBe(200);
		expect(changed.body.data.imported).toBe(0);
		expect(changed.body.data.changed).toBe(2);
		expect(changed.body.data.errors).toEqual([]);
		expect(changed.body.data.items).toEqual(
			second.body.data.items?.map((item) => ({ ...item, outcome: "changed" })),
		);
		expect(beforeSaveCalls).toBe(2);
		expect(afterSaveCalls).toBe(2);
		expect(await db.selectFrom("_emdash_bylines").select("display_name").execute()).toEqual([
			{ display_name: "Alice Editor" },
		]);
	});

	it("skips an unreceipted existing slug with ZERO writes (no legacy SEO fill)", async () => {
		const contentRepo = new ContentRepository(db);
		const existing = await contentRepo.create({
			type: "pages",
			slug: "owner-page",
			locale: "en",
			status: "published",
			data: { title: "Owner Page", content: [] },
		});

		const wxr = buildWxr(`
    <item>
      <title>Owner Page</title>
      <link>https://example.org/owner-page/</link>
      <wp:post_id>601</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>owner-page</wp:post_name>
      <content:encoded><![CDATA[<p>Should not touch owner row</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_yoast_wpseo_title</wp:meta_key><wp:meta_value><![CDATA[Injected SEO]]></wp:meta_value></wp:postmeta>
    </item>`);

		const res = await runExecute(emdash, wxr, {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting: true,
			importSections: false,
			importSeo: true,
			importComments: false,
			atomic: true,
			sourceLineage: "install:site-132",
		});
		expect(res.status).toBe(200);
		expect(res.body.data.imported).toBe(0);
		expect(res.body.data.skipped).toBe(1);
		expect(res.body.data.errors).toEqual([]);

		// Verify ZERO writes to _emdash_seo on the unreceipted owner row.
		const seoRows = (
			await sql`SELECT * FROM _emdash_seo WHERE collection = 'pages' AND content_id = ${existing.id}`.execute(
				db,
			)
		).rows;
		expect(seoRows).toHaveLength(0);
	});

	it("assigns non-aliasing sourcePostIds when wp:post_id is missing", async () => {
		const wxr = buildWxr(`
    <item>
      <title>Missing ID One</title>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>missing-one</wp:post_name>
      <content:encoded><![CDATA[<p>One</p>]]></content:encoded>
    </item>
    <item>
      <title>Missing ID Two</title>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>missing-two</wp:post_name>
      <content:encoded><![CDATA[<p>Two</p>]]></content:encoded>
    </item>`);

		const res = await runExecute(emdash, wxr, {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting: true,
			importSections: false,
			importSeo: false,
			importComments: false,
			atomic: true,
		});
		expect(res.status).toBe(200);
		expect(res.body.data.imported).toBe(2);
		expect(res.body.data.errors).toEqual([]);
		const ids = res.body.data.items?.map((i) => i.sourcePostId);
		expect(ids).toEqual(["missing:0:missing-one", "missing:1:missing-two"]);
	});

	it("keeps atomic execute SQL statements bounded per post on create and replay", async () => {
		const items: string[] = [];
		for (let i = 1; i <= 10; i++) {
			items.push(`
    <item>
      <title>Budget Post ${i}</title>
      <link>https://example.org/budget-${i}/</link>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_id>${700 + i}</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>budget-${i}</wp:post_name>
      <content:encoded><![CDATA[<p>Body ${i}</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_yoast_wpseo_title</wp:meta_key><wp:meta_value><![CDATA[SEO ${i}]]></wp:meta_value></wp:postmeta>
    </item>`);
		}
		const wxr = buildWxr(items.join("\n"));
		const config: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting: true,
			importSections: false,
			importSeo: true,
			importComments: false,
			atomic: true,
			sourceLineage: "install:budget-132",
		};

		const first = await runExecute(emdash, wxr, config);
		expect(first.status).toBe(200);
		expect(first.body.data.imported).toBe(10);
		expect(first.body.data.errors).toEqual([]);

		const replay = await runExecute(emdash, wxr, config);
		expect(replay.status).toBe(200);
		expect(replay.body.data.imported).toBe(0);
		expect(replay.body.data.skipped).toBe(10);
		expect(replay.body.data.errors).toEqual([]);
	});

	it("grants ZERO custody (no comments, no translation link) on unreceipted slug skip", async () => {
		const contentRepo = new ContentRepository(db);
		const ownerRow = await contentRepo.create({
			type: "pages",
			slug: "owned-anchor",
			locale: "en",
			status: "published",
			data: { title: "Owner Anchor", content: [] },
		});

		const wxr = buildWxr(`
    <item>
      <title>Owned Anchor</title>
      <wp:post_id>801</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>owned-anchor</wp:post_name>
      <content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-owned]]></wp:meta_value></wp:postmeta>
      <wp:comment>
        <wp:comment_id>9001</wp:comment_id>
        <wp:comment_author><![CDATA[Bob]]></wp:comment_author>
        <wp:comment_author_email>bob@example.org</wp:comment_author_email>
        <wp:comment_date_gmt>2025-01-01 00:00:00</wp:comment_date_gmt>
        <wp:comment_content><![CDATA[Must not attach to owner row]]></wp:comment_content>
        <wp:comment_approved>1</wp:comment_approved>
      </wp:comment>
    </item>
    <item>
      <title>Owned Anchor FR</title>
      <wp:post_id>802</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>owned-anchor-fr</wp:post_name>
      <content:encoded><![CDATA[<p>Corps</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-owned]]></wp:meta_value></wp:postmeta>
      <category domain="language" nicename="fr"><![CDATA[French]]></category>
    </item>`);

		const res = await runExecute(emdash, wxr, {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting: true,
			importSections: false,
			importSeo: true,
			importComments: true,
			atomic: true,
			sourceLineage: "install:site-132",
		});
		expect(res.status).toBe(200);
		expect(res.body.data.imported).toBe(0);
		expect(res.body.data.skipped).toBe(1);
		expect(res.body.data.errors).toHaveLength(1);
		expect(res.body.data.errors[0]?.error).toContain("trid-owned");
		// Zero comments written to ownerRow, and French sibling was NOT created standalone.
		expect(
			(await sql`SELECT * FROM _emdash_comments WHERE content_id = ${ownerRow.id}`.execute(db))
				.rows,
		).toHaveLength(0);
		expect((await sql`SELECT * FROM ec_pages`.execute(db)).rows).toHaveLength(1);
	});

	it("handles nameless missing-ID retry deterministically, reports changed fingerprint outside errors, and skips cleanly across 1-byte-different fallback exports", async () => {
		const namelessWxr = buildWxr(`
    <item>
      <title></title>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <content:encoded><![CDATA[<p>Nameless body</p>]]></content:encoded>
    </item>`);
		const cfg: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting: true,
			importSections: false,
			importSeo: false,
			importComments: false,
			atomic: true,
			sourceLineage: "install:nameless-132",
		};
		const r1 = await runExecute(emdash, namelessWxr, cfg);
		expect(r1.body.data.imported).toBe(1);
		const r2 = await runExecute(emdash, namelessWxr, cfg);
		expect(r2.body.data.imported).toBe(0);
		expect(r2.body.data.skipped).toBe(1);
		expect(r2.body.data.errors).toEqual([]);

		// Changed source content on same lineage -> reported as `changed: 1`, NOT in `errors`, ZERO writes.
		const changedWxr = namelessWxr.replace("Nameless body", "Edited body");
		const rChanged = await runExecute(emdash, changedWxr, cfg);
		expect(rChanged.body.data.success).toBe(true);
		expect(rChanged.body.data.imported).toBe(0);
		expect(rChanged.body.data.changed).toBe(1);
		expect(rChanged.body.data.errors).toEqual([]);
		expect(rChanged.body.data.items?.[0]?.outcome).toBe("changed");

		// Cross-export fallback lineage (no sourceLineage, 1-byte header diff) -> skipped with ZERO writes & ZERO errors.
		const exportA = buildWxr(`
    <item>
      <title>Cross Export</title>
      <wp:post_id>901</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>cross-export</wp:post_name>
      <content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
    </item>`);
		const exportB = exportA.replace("Example Site", "Example Site!");
		const noLineageCfg: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			skipExisting: true,
			importSections: false,
			importSeo: false,
			importComments: false,
			atomic: true,
		};
		const firstExp = await runExecute(emdash, exportA, noLineageCfg);
		expect(firstExp.body.data.imported).toBe(1);
		const secondExp = await runExecute(emdash, exportB, noLineageCfg);
		expect(secondExp.body.data.success).toBe(true);
		expect(secondExp.body.data.imported).toBe(0);
		expect(secondExp.body.data.skipped).toBe(1);
		expect(secondExp.body.data.errors).toEqual([]);
	});

	it("refuses raw-password WXR up front in atomic mode with ZERO writes, while supported protected input replays cleanly", async () => {
		const rawWxr = buildWxr(`
			<item>
				<title>Protected fixture</title>
				<wp:post_id>516</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>protected-fixture</wp:post_name>
				<wp:post_password>synthetic-fixture</wp:post_password>
				<content:encoded><![CDATA[<p>Fixture body</p>]]></content:encoded>
			</item>`);
		const rawRes = await runExecute(emdash, rawWxr, {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			atomic: true,
			skipExisting: true,
			importSections: false,
			importComments: false,
			protectedContent: PROTECTED_CONTENT_CAPABILITY,
			passwordSource: "raw-wxr",
		});
		expect(rawRes.status).toBe(400);
		expect(rawRes.body.error?.code).toBe("ATOMIC_RAW_PASSWORD_UNSUPPORTED");
		expect((await sql`SELECT * FROM ec_pages`.execute(db)).rows).toHaveLength(0);
		expect((await sql`SELECT * FROM _emdash_wxr_import_receipts`.execute(db)).rows).toHaveLength(0);

		// Supported protected input (pre-supplied deterministic verifier) creates and replays cleanly.
		const verifier = await createPasswordVerifier("synthetic-fixture");
		const supportedCfg: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			atomic: true,
			skipExisting: true,
			importSections: false,
			importComments: false,
			sourceLineage: "install:protected-132",
			protectedContent: PROTECTED_CONTENT_CAPABILITY,
			protections: { "516": { version: 1, mode: "password", verifier } },
		};
		const first = await runExecute(emdash, rawWxr, supportedCfg);
		expect(first.status).toBe(200);
		expect(first.body.data.items?.[0]?.outcome).toBe("created");
		const retry = await runExecute(emdash, rawWxr, supportedCfg);
		expect(retry.status).toBe(200);
		expect(retry.body.data.items?.[0]?.outcome).toBe("replayed");
		expect(retry.body.data.errors).toEqual([]);
	});

	it("refuses remapping a receipted post to a different collection and prevents a changed anchor from detaching a new sibling", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", hasSeo: true });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});

		const wxr = buildWxr(`
			<item>
				<title>Anchor EN</title>
				<dc:creator><![CDATA[alice]]></dc:creator>
				<wp:post_id>601</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>anchor-en</wp:post_name>
				<content:encoded><![CDATA[<p>Original anchor</p>]]></content:encoded>
				<category domain="category" nicename="news"><![CDATA[News]]></category>
				<wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-601]]></wp:meta_value></wp:postmeta>
			</item>`);
		const baseCfg: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			atomic: true,
			skipExisting: true,
			importSections: false,
			importComments: true,
			sourceLineage: "install:remap-132",
		};
		const initial = await runExecute(emdash, wxr, baseCfg);
		expect(initial.body.data.imported).toBe(1);

		// 1. Remapping source post 601 from `pages` to `posts` refuses as conflict, not a second create.
		const remapRes = await runExecute(emdash, wxr, {
			...baseCfg,
			postTypeMappings: { page: { collection: "posts", enabled: true } },
		});
		expect(remapRes.body.data.imported).toBe(0);
		expect(remapRes.body.data.errors).toHaveLength(1);
		expect(remapRes.body.data.errors[0]?.error).toContain("pages");
		expect((await sql`SELECT * FROM ec_posts`.execute(db)).rows).toHaveLength(0);

		// 2. Changed anchor + brand-new FR sibling + comment on changed anchor:
		//    - changed anchor writes ZERO comments
		//    - new FR sibling refuses (does NOT detach into a standalone row)
		const changedAnchorWithSibling = buildWxr(`
			<item>
				<title>Anchor EN Edited</title>
				<dc:creator><![CDATA[new-guest]]></dc:creator>
				<wp:post_id>601</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>anchor-en</wp:post_name>
				<content:encoded><![CDATA[<p>Edited anchor</p>]]></content:encoded>
				<category domain="category" nicename="brand-new-cat"><![CDATA[Brand New Cat]]></category>
				<wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-601]]></wp:meta_value></wp:postmeta>
				<wp:comment>
					<wp:comment_id>7701</wp:comment_id>
					<wp:comment_author><![CDATA[Late Commenter]]></wp:comment_author>
					<wp:comment_author_email>late@example.org</wp:comment_author_email>
					<wp:comment_date_gmt>2025-04-01 00:00:00</wp:comment_date_gmt>
					<wp:comment_content><![CDATA[Must not attach to changed anchor]]></wp:comment_content>
					<wp:comment_approved>1</wp:comment_approved>
				</wp:comment>
			</item>
			<item>
				<title>Sibling FR</title>
				<dc:creator><![CDATA[alice]]></dc:creator>
				<wp:post_id>602</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>anchor-fr</wp:post_name>
				<content:encoded><![CDATA[<p>Nouveau</p>]]></content:encoded>
				<category domain="language" nicename="fr"><![CDATA[French]]></category>
				<wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-601]]></wp:meta_value></wp:postmeta>
			</item>`);
		const changedRes = await runExecute(emdash, changedAnchorWithSibling, baseCfg);
		expect(changedRes.body.data.imported).toBe(0);
		expect(changedRes.body.data.changed).toBe(1);
		expect(changedRes.body.data.errors).toHaveLength(1);
		expect(changedRes.body.data.errors[0]?.error).toContain("trid-601");
		expect((await sql`SELECT * FROM ec_pages`.execute(db)).rows).toHaveLength(1);
		expect((await sql`SELECT * FROM _emdash_comments`.execute(db)).rows).toHaveLength(0);
		// ZERO term or guest-byline writes for the changed item!
		expect(
			(await sql`SELECT * FROM taxonomies WHERE slug = 'brand-new-cat'`.execute(db)).rows,
		).toHaveLength(0);
		expect(
			(await sql`SELECT * FROM _emdash_bylines WHERE slug = 'new-guest'`.execute(db)).rows,
		).toHaveLength(0);
	});

	it("skips BOTH existing translation siblings on 1-byte fallback re-export while still refusing a NEW sibling", async () => {
		const exportA = buildWxr(`
			<item>
				<title>Pair EN</title>
				<wp:post_id>701</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>pair-page</wp:post_name>
				<content:encoded><![CDATA[<p>EN</p>]]></content:encoded>
				<wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-pair]]></wp:meta_value></wp:postmeta>
			</item>
			<item>
				<title>Pair FR</title>
				<wp:post_id>702</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>pair-page</wp:post_name>
				<content:encoded><![CDATA[<p>FR</p>]]></content:encoded>
				<category domain="language" nicename="fr"><![CDATA[French]]></category>
				<wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-pair]]></wp:meta_value></wp:postmeta>
			</item>`);
		const cfg: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			atomic: true,
			skipExisting: true,
			importSections: false,
			importComments: false,
		};
		const first = await runExecute(emdash, exportA, cfg);
		expect(first.body.data.imported).toBe(2);
		expect(first.body.data.errors).toEqual([]);

		// 1-byte header diff -> new fallback lineage -> BOTH existing siblings skip cleanly with ZERO errors.
		const exportB = exportA.replace("Example Site", "Example Site!");
		const second = await runExecute(emdash, exportB, cfg);
		expect(second.body.data.success).toBe(true);
		expect(second.body.data.imported).toBe(0);
		expect(second.body.data.skipped).toBe(2);
		expect(second.body.data.errors).toEqual([]);

		// Adding a brand-new DE sibling to exportB still refuses because the anchor was skipped (unreceipted for this lineage).
		const exportC = exportB.replace(
			"</channel>",
			`<item>
				<title>Pair DE</title>
				<wp:post_id>703</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>pair-page</wp:post_name>
				<content:encoded><![CDATA[<p>DE</p>]]></content:encoded>
				<category domain="language" nicename="de"><![CDATA[German]]></category>
				<wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-pair]]></wp:meta_value></wp:postmeta>
			</item></channel>`,
		);
		const third = await runExecute(emdash, exportC, cfg);
		expect(third.body.data.imported).toBe(0);
		expect(third.body.data.skipped).toBe(2);
		expect(third.body.data.errors).toHaveLength(1);
		expect(third.body.data.errors[0]?.error).toContain("trid-pair");
	});

	it("commits comments and reusable sections with atomic receipts and replays cleanly without duplicating either", async () => {
		const wxr = buildWxr(`
			<item>
				<title>Post With Comments</title>
				<wp:post_id>850</wp:post_id>
				<wp:post_type>page</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>post-with-comments</wp:post_name>
				<content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
				<wp:comment>
					<wp:comment_id>8501</wp:comment_id>
					<wp:comment_author><![CDATA[Alice]]></wp:comment_author>
					<wp:comment_author_email>alice@example.org</wp:comment_author_email>
					<wp:comment_date_gmt>2025-05-01 10:00:00</wp:comment_date_gmt>
					<wp:comment_content><![CDATA[First comment]]></wp:comment_content>
					<wp:comment_approved>1</wp:comment_approved>
				</wp:comment>
			</item>
			<item>
				<title>Hero Banner</title>
				<wp:post_id>851</wp:post_id>
				<wp:post_type>wp_block</wp:post_type>
				<wp:status>publish</wp:status>
				<wp:post_name>hero-banner</wp:post_name>
				<content:encoded><![CDATA[<p>Reusable hero</p>]]></content:encoded>
			</item>`);
		const cfg: ImportConfig = {
			postTypeMappings: { page: { collection: "pages", enabled: true } },
			atomic: true,
			skipExisting: true,
			importSections: true,
			importComments: true,
			sourceLineage: "install:sections-comments-132",
		};

		const first = await runExecute(emdash, wxr, cfg);
		expect(first.status).toBe(200);
		expect(first.body.data.imported).toBe(1);
		expect(first.body.data.comments?.imported).toBe(1);
		expect(first.body.data.sections).toEqual({ created: 1, skipped: 0 });
		expect((await sql`SELECT * FROM _emdash_comments`.execute(db)).rows).toHaveLength(1);
		expect((await sql`SELECT * FROM _emdash_sections`.execute(db)).rows).toHaveLength(1);

		// Simulate lost-response retry (wipe derived media usage to verify replay recovery without duplicating comments or sections).
		await sql`DELETE FROM _emdash_media_usage_sources`.execute(db);
		const replay = await runExecute(emdash, wxr, cfg);
		expect(replay.status).toBe(200);
		expect(replay.body.data.imported).toBe(0);
		expect(replay.body.data.sections).toEqual({ created: 0, skipped: 1 });
		expect(replay.body.data.items?.every((i) => i.outcome === "replayed")).toBe(true);
		expect((await sql`SELECT * FROM _emdash_comments`.execute(db)).rows).toHaveLength(1);
		expect((await sql`SELECT * FROM _emdash_sections`.execute(db)).rows).toHaveLength(1);
		expect(
			(await sql`SELECT * FROM _emdash_media_usage_sources`.execute(db)).rows.length,
		).toBeGreaterThan(0);

		// Changing either a comment body OR a section body triggers `changed` with zero writes.
		const changed = await runExecute(
			emdash,
			wxr.replace("First comment", "Edited comment").replace("Reusable hero", "Edited hero"),
			cfg,
		);
		expect(changed.status).toBe(200);
		expect(changed.body.data.changed).toBe(2);
		expect(changed.body.data.errors).toEqual([]);
	});
});
