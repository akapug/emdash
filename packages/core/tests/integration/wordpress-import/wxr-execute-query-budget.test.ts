/**
 * Item 129: WXR execute query budget & object-cache coalescing.
 *
 * A single-request WXR execute importing ~200 posts over Cloudflare D1 must not
 * amplify into 25-40+ sequential SQL round-trips per row or hammer KV with
 * per-row epoch writes, otherwise slow D1 primary shards blow past undici's
 * 300s headersTimeout.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	POST as executePost,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildMultiPostWxr(count: number): string {
	const items: string[] = [];
	for (let i = 1; i <= count; i++) {
		items.push(`
    <item>
      <title>Event Number ${i}</title>
      <link>https://example.org/events/event-${i}/</link>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <wp:post_id>${100 + i}</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>event-${i}</wp:post_name>
      <content:encoded><![CDATA[<p>Body paragraph for item ${i}.</p>]]></content:encoded>
      <wp:postmeta><wp:meta_key>_yoast_wpseo_title</wp:meta_key><wp:meta_value><![CDATA[SEO Title ${i}]]></wp:meta_value></wp:postmeta>
    </item>`);
	}
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
    ${items.join("\n")}
  </channel>
</rss>`;
}

const CONFIG: ImportConfig = {
	postTypeMappings: {
		page: { collection: "pages", enabled: true },
	},
	skipExisting: true,
	importSections: false,
	importSeo: true,
	importComments: false,
};

describe("WXR execute query budget and cache coalescing", () => {
	let rawDb: Kysely<Database>;

	beforeEach(async () => {
		__setObjectCacheBackendForTests(null);
		rawDb = await setupTestDatabase();
		const registry = new SchemaRegistry(rawDb);
		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			hasSeo: true,
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("pages", { slug: "excerpt", label: "Excerpt", type: "text" });
	});

	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(rawDb);
	});

	it("keeps SQL round-trips bounded per imported row and coalesces object-cache epoch writes", async () => {
		let queryCount = 0;
		const countedDb = rawDb.withPlugin({
			transformQuery(args) {
				queryCount += 1;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});

		const backendSets: string[] = [];
		const spyBackend: ObjectCacheBackend = {
			async get() {
				return null;
			},
			async set(key) {
				backendSets.push(key);
			},
			async delete() {},
		};
		__setObjectCacheBackendForTests(spyBackend);

		const runtime = createTestRuntime(countedDb);
		const emdash: EmDashHandlers = handlersFromRuntime(runtime);
		const wxr = buildMultiPostWxr(20);

		const runExecute = async () => {
			const formData = new FormData();
			formData.append("file", new File([wxr], "export.xml", { type: "application/xml" }));
			formData.append("config", JSON.stringify(CONFIG));
			const request = new Request("https://example.org/_emdash/api/import/wordpress/execute", {
				method: "POST",
				body: formData,
			});
			const ctx = {
				editMode: false,
				metrics: createRequestMetrics(performance.now()),
			};
			return runWithContext(ctx, () =>
				executePost({
					request,
					locals: {
						emdash,
						user: {
							id: "admin-1",
							role: 100,
						},
					},
				} as Parameters<typeof executePost>[0]),
			);
		};

		queryCount = 0;
		backendSets.length = 0;
		const firstRes = await runExecute();
		expect(firstRes.status).toBe(200);
		const firstBody = (await firstRes.json()) as {
			success: boolean;
			data: { imported: number; skipped: number; errors: unknown[] };
		};
		expect(firstBody.success).toBe(true);
		expect(firstBody.data.imported).toBe(20);
		expect(firstBody.data.errors).toEqual([]);

		const queriesOnCreate = queryCount;

		// Allow scheduled microtask/after epoch writes to flush.
		await new Promise((r) => setTimeout(r, 20));

		const setsOnCreate = [...backendSets];

		// Verify all 20 rows landed cleanly in the DB.
		const repo = new ContentRepository(rawDb);
		const stored = await repo.findMany("pages", { limit: 50 });
		expect(stored.items).toHaveLength(20);

		// Re-run with skipExisting: true — must not issue N separate findBySlug queries.
		queryCount = 0;
		const secondRes = await runExecute();
		expect(secondRes.status).toBe(200);
		const secondBody = (await secondRes.json()) as {
			success: boolean;
			data: { imported: number; skipped: number; errors: unknown[] };
		};
		expect(secondBody.data.imported).toBe(0);
		expect(secondBody.data.skipped).toBe(20);
		const queriesOnSkip = queryCount;

		// Budget assertions:
		// 1. Creating 20 posts must stay <= 12 SQL queries/post (<= 260 total including setup).
		expect(
			queriesOnCreate,
			`Expected <= 260 SQL queries for 20 created posts, got ${queriesOnCreate}`,
		).toBeLessThanOrEqual(260);

		// 2. Skipping 20 existing posts must stay <= 50 SQL queries total (preloaded slug map).
		expect(
			queriesOnSkip,
			`Expected <= 50 SQL queries for 20 skipped posts, got ${queriesOnSkip}`,
		).toBeLessThanOrEqual(50);

		// 3. Object-cache epoch writes must be coalesced (at most 1 write per key).
		const countsByKey = new Map<string, number>();
		for (const k of setsOnCreate) countsByKey.set(k, (countsByKey.get(k) ?? 0) + 1);
		for (const [k, n] of countsByKey) {
			expect(n, `Expected coalesced KV write for ${k}, saw ${n}`).toBeLessThanOrEqual(1);
		}
	});

	it("invalidates request-cached schema metadata when a field is added mid-request", async () => {
		const registry = new SchemaRegistry(rawDb);
		const ctx = { editMode: false, metrics: createRequestMetrics(performance.now()) };
		await runWithContext(ctx, async () => {
			const before = await registry.getCollectionWithFields("pages");
			expect(before?.fields.some((f) => f.slug === "subtitle")).toBe(false);

			await registry.createField("pages", {
				slug: "subtitle",
				label: "Subtitle",
				type: "string",
			});

			const afterAdd = await registry.getCollectionWithFields("pages");
			expect(afterAdd?.fields.some((f) => f.slug === "subtitle")).toBe(true);
		});
	});
});
