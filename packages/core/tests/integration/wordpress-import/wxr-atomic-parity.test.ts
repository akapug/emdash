/**
 * Item 132 (Lead #1): Legacy vs Atomic WXR execute full-database parity proof.
 *
 * Imports the SAME rich WXR fixture (two authors, SEO on some rows, categories +
 * tags, one scheduled post, one password-protected page, one translation pair,
 * event row with mappedFields and an embed, and a post with approved comments)
 * once on the legacy path (`atomic: false`) and once on the atomic path
 * (`atomic: true`) into two fresh databases, dumps every table except the two
 * new atomic-receipt tables, normalizes generated IDs / timestamps / Portable
 * Text `_key`s, and asserts exact parity (including confirming `revisions` is
 * empty in BOTH legacy and atomic).
 */

import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	POST as executePost,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import {
	createPasswordVerifier,
	PROTECTED_CONTENT_CAPABILITY,
} from "../../../src/content/protection.js";
import type { Database } from "../../../src/database/types.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const RICH_PARITY_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:wp="http://wordpress.org/export/1.2/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Parity Site</title>
    <link>https://parity.example.org</link>
    <language>en-US</language>
    <wp:author>
      <wp:author_login><![CDATA[alice]]></wp:author_login>
      <wp:author_display_name><![CDATA[Alice Editor]]></wp:author_display_name>
    </wp:author>
    <wp:author>
      <wp:author_login><![CDATA[bob]]></wp:author_login>
      <wp:author_display_name><![CDATA[Bob Writer]]></wp:author_display_name>
    </wp:author>
    <wp:category>
      <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
    </wp:category>
    <wp:tag>
      <wp:tag_slug><![CDATA[featured]]></wp:tag_slug>
      <wp:tag_name><![CDATA[Featured]]></wp:tag_name>
    </wp:tag>
    <item>
      <title>Published Post With Comments</title>
      <link>https://parity.example.org/published-post/</link>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_id>101</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>published-post</wp:post_name>
      <wp:post_date_gmt>2025-03-01 10:00:00</wp:post_date_gmt>
      <content:encoded><![CDATA[<p>Hello parity world.</p>]]></content:encoded>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <category domain="post_tag" nicename="featured"><![CDATA[Featured]]></category>
      <wp:postmeta><wp:meta_key>_yoast_wpseo_title</wp:meta_key><wp:meta_value><![CDATA[Published SEO]]></wp:meta_value></wp:postmeta>
      <wp:comment>
        <wp:comment_id>5001</wp:comment_id>
        <wp:comment_author><![CDATA[Reader]]></wp:comment_author>
        <wp:comment_author_email>reader@example.org</wp:comment_author_email>
        <wp:comment_date_gmt>2025-03-02 12:00:00</wp:comment_date_gmt>
        <wp:comment_content><![CDATA[Great post!]]></wp:comment_content>
        <wp:comment_approved>1</wp:comment_approved>
      </wp:comment>
    </item>
    <item>
      <title>Scheduled Future Post</title>
      <link>https://parity.example.org/scheduled-post/</link>
      <dc:creator><![CDATA[bob]]></dc:creator>
      <wp:post_id>102</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>future</wp:status>
      <wp:post_name>scheduled-post</wp:post_name>
      <wp:post_date_gmt>2030-08-15 09:30:00</wp:post_date_gmt>
      <content:encoded><![CDATA[<p>Future content.</p>]]></content:encoded>
    </item>
    <item>
      <title>Protected Page</title>
      <link>https://parity.example.org/protected-page/</link>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_id>103</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>protected-page</wp:post_name>
      <wp:post_password>top-secret</wp:post_password>
      <content:encoded><![CDATA[<p>Members only.</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_yoast_wpseo_title</wp:meta_key><wp:meta_value><![CDATA[Protected SEO]]></wp:meta_value></wp:postmeta>
    </item>
    <item>
      <title>Multilingual Anchor</title>
      <link>https://parity.example.org/multi-en/</link>
      <dc:creator><![CDATA[bob]]></dc:creator>
      <wp:post_id>104</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>multi-post</wp:post_name>
      <content:encoded><![CDATA[<p>English version.</p>]]></content:encoded>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-104]]></wp:meta_value></wp:postmeta>
    </item>
    <item>
      <title>Multilingual French</title>
      <link>https://parity.example.org/fr/multi-post/</link>
      <dc:creator><![CDATA[bob]]></dc:creator>
      <wp:post_id>105</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>multi-post</wp:post_name>
      <content:encoded><![CDATA[<p>Version francaise.</p>]]></content:encoded>
      <category domain="language" nicename="fr"><![CDATA[French]]></category>
      <wp:postmeta><wp:meta_key>_icl_translation_id</wp:meta_key><wp:meta_value><![CDATA[trid-104]]></wp:meta_value></wp:postmeta>
    </item>
    <item>
      <title>Community Gathering</title>
      <link>https://parity.example.org/events/gathering/</link>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_id>106</wp:post_id>
      <wp:post_type>mec-events</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>community-gathering</wp:post_name>
      <content:encoded><![CDATA[<p>Event description [MEC id="1"].</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EMBEDDED_ULID_PATTERN = /[0-9A-HJKMNP-TV-Z]{26}/g;
const ISO_TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function mapId(raw: string, idMap: Map<string, string>): string {
	let token = idMap.get(raw);
	if (!token) {
		token = `ID_${idMap.size + 1}`;
		idMap.set(raw, token);
	}
	return token;
}

function normalizeJsonValue(value: unknown, idMap: Map<string, string>): unknown {
	if (typeof value === "string") {
		if (ULID_PATTERN.test(value)) {
			return mapId(value, idMap);
		}
		if (ISO_TS_PATTERN.test(value) && !value.startsWith("2025-") && !value.startsWith("2030-")) {
			return "NOW_TS";
		}
		if (value.startsWith("media-usage-projection:v1:sha256:")) {
			return "MEDIA_USAGE_FINGERPRINT";
		}
		return value.replace(EMBEDDED_ULID_PATTERN, (match) => mapId(match, idMap));
	}
	if (Array.isArray(value)) {
		return value.map((item) => normalizeJsonValue(item, idMap));
	}
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = k === "_key" ? "KEY" : normalizeJsonValue(v, idMap);
		}
		return out;
	}
	return value;
}

function normalizeRow(
	row: Record<string, unknown>,
	idMap: Map<string, string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		if (typeof v === "string" && (v.startsWith("[") || v.startsWith("{"))) {
			try {
				const parsed: unknown = JSON.parse(v);
				out[k] = JSON.stringify(normalizeJsonValue(parsed, idMap));
				continue;
			} catch {
				// Not JSON; fall through
			}
		}
		out[k] = normalizeJsonValue(v, idMap);
	}
	return out;
}

async function setupParityDb(): Promise<{ db: Kysely<Database>; emdash: EmDashHandlers }> {
	const db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);
	for (const col of [
		{ slug: "posts", label: "Posts" },
		{ slug: "pages", label: "Pages" },
		{ slug: "events", label: "Events" },
	]) {
		// oxlint-disable-next-line no-await-in-loop -- sequential collection setup
		await registry.createCollection({ slug: col.slug, label: col.label, hasSeo: true });
		// oxlint-disable-next-line no-await-in-loop -- sequential field setup
		await registry.createField(col.slug, { slug: "title", label: "Title", type: "string" });
		// oxlint-disable-next-line no-await-in-loop -- sequential field setup
		await registry.createField(col.slug, {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		// oxlint-disable-next-line no-await-in-loop -- sequential field setup
		await registry.createField(col.slug, { slug: "excerpt", label: "Excerpt", type: "text" });
	}
	await registry.createField("events", { slug: "start_date", label: "Start Date", type: "string" });
	await registry.createField("events", { slug: "location", label: "Location", type: "string" });
	const runtime = createTestRuntime(db);
	return { db, emdash: handlersFromRuntime(runtime) };
}

async function seedDeterministicIdMap(db: Kysely<Database>): Promise<Map<string, string>> {
	const idMap = new Map<string, string>();
	const cols = (
		await sql<{ id: string; slug: string }>`
			SELECT id, slug FROM _emdash_collections ORDER BY slug ASC
		`.execute(db)
	).rows;
	const colSlugById = new Map<string, string>();
	for (const c of cols) {
		idMap.set(c.id, `COL_${c.slug}`);
		colSlugById.set(c.id, c.slug);
	}
	const fields = (
		await sql<{ id: string; collection_id: string; slug: string }>`
			SELECT id, collection_id, slug FROM _emdash_fields ORDER BY slug ASC
		`.execute(db)
	).rows;
	for (const f of fields) {
		idMap.set(f.id, `FLD_${colSlugById.get(f.collection_id) ?? "x"}_${f.slug}`);
	}
	const bylines = (
		await sql<{ id: string; slug: string; locale: string; translation_group: string | null }>`
			SELECT id, slug, locale, translation_group FROM _emdash_bylines ORDER BY slug ASC, locale ASC
		`.execute(db)
	).rows;
	for (const b of bylines) {
		idMap.set(b.id, `BYL_${b.slug}_${b.locale}`);
		if (b.translation_group && !idMap.has(b.translation_group)) {
			idMap.set(b.translation_group, `BYLG_${b.slug}`);
		}
	}
	const taxDefs = (
		await sql<{ id: string; name: string; locale: string; translation_group: string | null }>`
			SELECT id, name, locale, translation_group FROM _emdash_taxonomy_defs ORDER BY name ASC, locale ASC
		`.execute(db)
	).rows;
	for (const td of taxDefs) {
		idMap.set(td.id, `TAXDEF_${td.name}_${td.locale}`);
		if (td.translation_group && !idMap.has(td.translation_group)) {
			idMap.set(td.translation_group, `TAXDEFG_${td.name}`);
		}
	}
	const terms = (
		await sql<{
			id: string;
			name: string;
			slug: string;
			locale: string;
			translation_group: string | null;
		}>`
			SELECT id, name, slug, locale, translation_group FROM taxonomies ORDER BY name ASC, slug ASC, locale ASC
		`.execute(db)
	).rows;
	for (const t of terms) {
		idMap.set(t.id, `TAX_${t.name}_${t.slug}_${t.locale}`);
		if (t.translation_group && !idMap.has(t.translation_group)) {
			idMap.set(t.translation_group, `TAXG_${t.name}_${t.slug}`);
		}
	}
	for (const col of ["posts", "pages", "events"] as const) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic collection scan
		const rows = (
			await sql<{
				id: string;
				slug: string | null;
				locale: string | null;
				translation_group: string | null;
			}>`
				SELECT id, slug, locale, translation_group FROM ${sql.ref(`ec_${col}`)} ORDER BY slug ASC, locale ASC
			`.execute(db)
		).rows;
		for (const r of rows) {
			const slug = r.slug ?? "noslug";
			const loc = r.locale ?? "en";
			idMap.set(r.id, `ROW_${col}_${slug}_${loc}`);
			if (r.translation_group && !idMap.has(r.translation_group)) {
				idMap.set(r.translation_group, `GRP_${col}_${slug}`);
			}
		}
	}
	const cbRows = (
		await sql<{ id: string; collection_slug: string; content_id: string; sort_order: number }>`
			SELECT id, collection_slug, content_id, sort_order FROM _emdash_content_bylines ORDER BY collection_slug ASC, sort_order ASC
		`.execute(db)
	).rows;
	for (const cb of cbRows) {
		idMap.set(
			cb.id,
			`CB_${cb.collection_slug}_${idMap.get(cb.content_id) ?? cb.content_id}_${cb.sort_order}`,
		);
	}
	const commentRows = (
		await sql<{ id: string; content_id: string; author_email: string | null }>`
			SELECT id, content_id, author_email FROM _emdash_comments ORDER BY author_email ASC
		`.execute(db)
	).rows;
	for (const cm of commentRows) {
		idMap.set(cm.id, `CMT_${idMap.get(cm.content_id) ?? cm.content_id}_${cm.author_email ?? ""}`);
	}
	return idMap;
}

async function dumpNormalizedTables(db: Kysely<Database>): Promise<Record<string, unknown[]>> {
	const tables = (
		await sql<{ name: string }>`
			SELECT name FROM sqlite_master
			WHERE type = 'table'
				AND name NOT LIKE 'sqlite_%'
				AND name NOT IN ('_emdash_wxr_import_receipts', '_emdash_wxr_group_baselines')
			ORDER BY name ASC
		`.execute(db)
	).rows.map((r) => r.name);

	const idMap = await seedDeterministicIdMap(db);
	const dump: Record<string, unknown[]> = {};
	for (const table of tables) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic table-by-table dump
		const rows = (await sql<Record<string, unknown>>`SELECT * FROM ${sql.ref(table)}`.execute(db))
			.rows;
		dump[table] = rows
			.map((row) => {
				const normalized = normalizeRow(row, idMap);
				if (table === "_emdash_media_usage_sources" && "current_generation" in normalized) {
					normalized.current_generation = "GEN";
				}
				return normalized;
			})
			.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	}
	return dump;
}

describe("Item 132: legacy vs atomic WXR execute parity", () => {
	let legacyDb: Kysely<Database>;
	let atomicDb: Kysely<Database>;

	beforeEach(async () => {
		legacyDb = (await setupParityDb()).db;
		atomicDb = (await setupParityDb()).db;
	});

	afterEach(async () => {
		await teardownTestDatabase(legacyDb);
		await teardownTestDatabase(atomicDb);
	});

	it("produces identical database state across every table (and zero revisions in both)", async () => {
		const verifier = await createPasswordVerifier("top-secret");
		const baseConfig: ImportConfig = {
			postTypeMappings: {
				post: { collection: "posts", enabled: true },
				page: { collection: "pages", enabled: true },
				"mec-events": { collection: "events", enabled: true },
			},
			skipExisting: true,
			importSections: false,
			importSeo: true,
			importComments: true,
			protectedContent: PROTECTED_CONTENT_CAPABILITY,
			protections: {
				"103": { version: 1, mode: "password", verifier },
			},
			mappedFields: {
				"106": { start_date: "2026-09-01", location: "Main Hall" },
			},
			embeds: {
				"106": {
					"1": {
						_type: "embed",
						_key: "mec-1",
						provider: "embark-events",
						url: "/events/",
						events: {
							version: 1,
							viewSlug: "upcoming",
							mode: "upcoming",
							order: "asc",
							layout: "list",
							start: "today",
						},
					},
				},
			},
		};

		const run = async (db: Kysely<Database>, atomic: boolean) => {
			const emdash = handlersFromRuntime(createTestRuntime(db));
			const formData = new FormData();
			formData.append(
				"file",
				new File([RICH_PARITY_WXR], "parity.xml", { type: "application/xml" }),
			);
			formData.append(
				"config",
				JSON.stringify({
					...baseConfig,
					atomic,
					...(atomic ? { sourceLineage: "install:parity" } : {}),
				}),
			);
			const res = await runWithContext(
				{ editMode: false, metrics: createRequestMetrics(performance.now()) },
				() =>
					executePost({
						request: new Request(
							"https://parity.example.org/_emdash/api/import/wordpress/execute",
							{
								method: "POST",
								body: formData,
							},
						),
						locals: { emdash, user: { id: "admin-1", role: 100, permissions: ["*"] } },
					} as never),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				success: boolean;
				data: { imported: number; errors: unknown[] };
			};
			expect(body.success).toBe(true);
			expect(body.data.imported).toBe(6);
			expect(body.data.errors).toEqual([]);
		};

		await run(legacyDb, false);
		await run(atomicDb, true);

		const legacyDump = await dumpNormalizedTables(legacyDb);
		const atomicDump = await dumpNormalizedTables(atomicDb);

		// Confirm neither legacy nor atomic writes an initial revision.
		expect(legacyDump.revisions).toEqual([]);
		expect(atomicDump.revisions).toEqual([]);
		// Compare every single table across the entire database.
		expect(atomicDump).toEqual(legacyDump);
	});
});
