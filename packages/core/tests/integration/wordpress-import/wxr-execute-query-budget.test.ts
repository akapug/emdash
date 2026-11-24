/**
 * Item 129: WXR execute query budget, object-cache coalescing, and cut-safety.
 *
 * Covers:
 * - Bounded SQL round-trips on create & skipExisting re-runs (vs 674 baseline)
 * - Coalesced KV epoch writes + periodic mid-import flush + retry cache healing (B3)
 * - Exact skipExisting semantics on any-locale matches & concurrent inserts (B1)
 * - Durable in-request media-usage debt when after() never runs (B2)
 * - Request-cached schema invalidation across SchemaRegistry & FTSManager (A1)
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as afterModule from "../../../src/after.js";
import { handleMediaUsageActivationAdvance } from "../../../src/api/handlers/media-usage-activation.js";
import {
	importContent,
	POST as executePost,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { processDueMediaUsageWork } from "../../../src/media/usage/work-processor.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	coalesceObjectCacheWrites,
	contentNamespaces,
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

function createMemoryBackend(): {
	backend: ObjectCacheBackend;
	store: Map<string, string>;
	sets: string[];
} {
	const store = new Map<string, string>();
	const sets: string[] = [];
	const backend: ObjectCacheBackend = {
		async get(key) {
			return store.get(key) ?? null;
		},
		async set(key, value) {
			sets.push(key);
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		},
	};
	return { backend, store, sets };
}

async function callExecutePost(
	emdash: EmDashHandlers,
	wxr: string,
	config: ImportConfig = CONFIG,
): Promise<Response> {
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
}

async function activateIncrementalCapture(db: Kysely<Database>) {
	for (let step = 0; step < 10; step++) {
		const res = await handleMediaUsageActivationAdvance(db, { writersDrained: true });
		if (!res.success) throw new Error(`activation failed: ${res.error.message}`);
		if (res.data.activation.state === "active") return;
	}
	throw new Error("incremental capture did not reach active state");
}

describe("WXR execute query budget, cache coalescing, and cut safety", () => {
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
		vi.restoreAllMocks();
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(rawDb);
	});

	it("keeps SQL round-trips bounded per imported row and coalesces object-cache epoch writes", async () => {
		// Production Cloudflare tenants activate incremental capture before import.
		await activateIncrementalCapture(rawDb);

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

		const { backend, sets } = createMemoryBackend();
		__setObjectCacheBackendForTests(backend);

		const runtime = createTestRuntime(countedDb);
		const emdash: EmDashHandlers = handlersFromRuntime(runtime);
		const wxr = buildMultiPostWxr(20);

		queryCount = 0;
		sets.length = 0;
		const firstRes = await callExecutePost(emdash, wxr);
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
		const setsOnCreate = [...sets];

		const repo = new ContentRepository(rawDb);
		const stored = await repo.findMany("pages", { limit: 50 });
		expect(stored.items).toHaveLength(20);

		// Re-run with skipExisting: true — preload HITs skip without DB round-trips.
		queryCount = 0;
		const secondRes = await callExecutePost(emdash, wxr);
		expect(secondRes.status).toBe(200);
		const secondBody = (await secondRes.json()) as {
			success: boolean;
			data: { imported: number; skipped: number; errors: unknown[] };
		};
		expect(secondBody.data.imported).toBe(0);
		expect(secondBody.data.skipped).toBe(20);
		const queriesOnSkip = queryCount;

		// 1. Creating 20 posts stays <= 280 SQL queries (vs 674 baseline on 0a7df0ffb5 & e1afa3c362).
		expect(
			queriesOnCreate,
			`Expected <= 280 SQL queries for 20 created posts, got ${queriesOnCreate}`,
		).toBeLessThanOrEqual(280);

		// 2. Skipping 20 existing posts stays <= 50 SQL queries total (preloaded slug + SEO maps).
		expect(
			queriesOnSkip,
			`Expected <= 50 SQL queries for 20 skipped posts, got ${queriesOnSkip}`,
		).toBeLessThanOrEqual(50);

		// 3. Object-cache epoch writes are coalesced (at most 1 write per key for 20 < 25 flush window).
		const countsByKey = new Map<string, number>();
		for (const k of setsOnCreate) countsByKey.set(k, (countsByKey.get(k) ?? 0) + 1);
		for (const [k, n] of countsByKey) {
			expect(n, `Expected coalesced KV write for ${k}, saw ${n}`).toBeLessThanOrEqual(1);
		}
	});

	it("B1a: skips an unlocalized post when an existing row lives under a non-default locale", async () => {
		const repo = new ContentRepository(rawDb);
		await repo.create({
			type: "pages",
			slug: "event-1",
			status: "published",
			locale: "fr",
			data: { title: "Existing French Page", content: [] },
		});

		const emdash = handlersFromRuntime(createTestRuntime(rawDb));
		const res = await callExecutePost(emdash, buildMultiPostWxr(1));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			data: { imported: number; skipped: number };
		};
		expect(body.data.imported).toBe(0);
		expect(body.data.skipped).toBe(1);

		const all = await repo.findMany("pages", { limit: 20 });
		expect(all.items).toHaveLength(1);
		expect(all.items[0]?.locale).toBe("fr");
	});

	it("B1b: confirms a preload MISS via findBySlug so a concurrent insert is skipped without creating -2", async () => {
		const runtime = createTestRuntime(rawDb);
		const emdash = handlersFromRuntime(runtime);
		const repo = new ContentRepository(rawDb);
		const origCreate = emdash.handleContentCreate.bind(emdash);

		// When event-1 is created, simulate a concurrent writer landing event-2
		// AFTER preload ran and BEFORE event-2's turn in the loop.
		let injected = false;
		emdash.handleContentCreate = async (collection, body, options) => {
			const res = await origCreate(collection, body, options);
			if (!injected && body.slug === "event-1") {
				injected = true;
				await repo.create({
					type: "pages",
					slug: "event-2",
					status: "published",
					locale: "en",
					data: { title: "Concurrent Event 2", content: [] },
				});
			}
			return res;
		};

		const res = await callExecutePost(emdash, buildMultiPostWxr(2));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			data: { imported: number; skipped: number };
		};
		expect(body.data.imported).toBe(1);
		expect(body.data.skipped).toBe(1);

		const all = await repo.findMany("pages", { limit: 20 });
		expect(all.items.map((item) => item.slug ?? "").toSorted((a, b) => a.localeCompare(b))).toEqual(
			["event-1", "event-2"],
		);
	});

	it("B1c: memoizes a preload-miss findBySlug hit under the row's stored locale so a later explicit default-locale item is still created", async () => {
		const runtime = createTestRuntime(rawDb);
		const emdash = handlersFromRuntime(runtime);
		const manifest = await emdash.getManifest();
		const repo = new ContentRepository(rawDb);
		const origCreate = emdash.handleContentCreate.bind(emdash);

		// Inject a French row for `shared-page` AFTER the preload query runs,
		// triggered during the first post's create.
		let injectedFrId: string | undefined;
		emdash.handleContentCreate = async (collection, body, options) => {
			const res = await origCreate(collection, body, options);
			if (!injectedFrId && body.slug === "seed-page") {
				const createdFr = await repo.create({
					type: "pages",
					slug: "shared-page",
					status: "published",
					locale: "fr",
					data: { title: "Page Partagee", content: [] },
				});
				injectedFrId = createdFr.id;
			}
			return res;
		};

		const wxr = await parseWxrString(buildMultiPostWxr(1));
		const seedPost = wxr.posts[0];
		expect(seedPost).toBeDefined();
		if (!seedPost) throw new Error("expected seed post");

		const posts = [
			{ ...seedPost, id: 1, title: "Seed Page", postName: "seed-page", locale: undefined },
			// Locale-less item: preload misses, findBySlug returns the injected French row -> skipped.
			{
				...seedPost,
				id: 2,
				title: "Shared Locale-less",
				postName: "shared-page",
				locale: undefined,
			},
			// Explicit English item with the same slug: must NOT hit the French memo -> CREATED.
			{ ...seedPost, id: 3, title: "Shared English", postName: "shared-page", locale: "en" },
		];
		const plan = await preImportWxrTaxonomies(rawDb, posts, [], [], []);

		const importResult = await importContent(
			posts,
			CONFIG,
			emdash,
			manifest,
			new Map(),
			undefined,
			undefined,
			plan,
			undefined,
			wxr.site.language,
			wxr.site.generator,
		);
		expect(importResult.imported).toBe(2);
		expect(importResult.skipped).toBe(1);
		expect(importResult.errors).toEqual([]);
		expect(injectedFrId).toBeDefined();

		const frRow = await repo.findBySlug("pages", "shared-page", "fr");
		const enRow = await repo.findBySlug("pages", "shared-page", "en");
		expect(frRow?.id).toBe(injectedFrId);
		expect(enRow?.id).toBeDefined();
		expect(enRow?.id).not.toBe(injectedFrId);
		expect(enRow?.locale).toBe("en");
	});

	it("B2: keeps media-usage durable with active capture and runs immediate refresh when inactive across interrupted/resumed import", async () => {
		// Suppress after() completely to simulate a cut Worker request.
		vi.spyOn(afterModule, "after").mockImplementation(() => {});

		// Part 1: incremental capture active — DB triggers durably enqueue work rows
		// so a later processDueMediaUsageWork tick computes usage for every created row.
		await activateIncrementalCapture(rawDb);

		const emdash = handlersFromRuntime(createTestRuntime(rawDb));
		const res = await callExecutePost(emdash, buildMultiPostWxr(3));
		expect(res.status).toBe(200);

		const pendingBeforeTick = await rawDb
			.selectFrom("_emdash_media_usage_work")
			.select(["collection_slug", "content_id", "state"])
			.where("collection_slug", "=", "pages")
			.execute();
		expect(pendingBeforeTick).toHaveLength(3);

		const tick = await processDueMediaUsageWork(rawDb);
		expect(tick.completedCount).toBe(3);

		const sourcesAfterTick = await rawDb
			.selectFrom("_emdash_media_usage_sources")
			.select(["source_key"])
			.where("collection_slug", "=", "pages")
			.execute();
		expect(sourcesAfterTick).toHaveLength(3);

		// Part 2: incremental capture inactive — immediate synchronous refresh runs
		// in-request so even with after() never running, an interrupted then resumed
		// import records media-usage sources for every created row.
		await rawDb
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "inactive", updated_at: new Date().toISOString() })
			.where("task_key", "=", "incremental_capture")
			.execute();

		const resAttempt1 = await callExecutePost(emdash, buildMultiPostWxr(4));
		expect(resAttempt1.status).toBe(200);
		const resResume = await callExecutePost(emdash, buildMultiPostWxr(5));
		expect(resResume.status).toBe(200);

		const sourcesAfterInactive = await rawDb
			.selectFrom("_emdash_media_usage_sources")
			.select(["source_key"])
			.where("collection_slug", "=", "pages")
			.execute();
		expect(sourcesAfterInactive).toHaveLength(5);
	});

	it("B3: flushes epochs periodically mid-import and heals cached lists on a skip-all retry after a cut", async () => {
		const { backend, sets } = createMemoryBackend();
		__setObjectCacheBackendForTests(backend);

		const emdash = handlersFromRuntime(createTestRuntime(rawDb));
		const manifest = await emdash.getManifest();

		// Part 1: periodic flush inside coalesceObjectCacheWrites fires before the outer scope closes.
		const wxr6 = await parseWxrString(buildMultiPostWxr(6));
		const plan6 = await preImportWxrTaxonomies(
			rawDb,
			wxr6.posts,
			wxr6.categories,
			wxr6.tags,
			wxr6.terms,
		);
		let midImportSetCount = 0;
		await coalesceObjectCacheWrites(async () => {
			await importContent(
				wxr6.posts,
				CONFIG,
				emdash,
				manifest,
				new Map(),
				undefined,
				undefined,
				plan6,
				undefined,
				wxr6.site.language,
				wxr6.site.generator,
				{ epochFlushInterval: 3 },
			);
			await new Promise((r) => setTimeout(r, 20));
			midImportSetCount = sets.length;
		});
		expect(midImportSetCount).toBeGreaterThan(0);

		// Part 2: prime a cached list read for "pages", simulate a cut attempt writing
		// event-7 directly to DB with NO epoch bump, then run a skip-all retry execute.
		const repo = new ContentRepository(rawDb);
		const readCachedList = () =>
			cachedQuery({
				namespace: contentNamespaces("pages"),
				key: "list:pages:all",
				load: async () => (await repo.findMany("pages", { limit: 50 })).items.map((i) => i.slug),
			});

		const beforeCut = await readCachedList();
		expect(beforeCut).toHaveLength(6);

		// Simulate cut attempt: row lands in D1 without bumping epochs (insert directly).
		await rawDb
			.insertInto("ec_pages" as keyof Database)
			.values({
				id: "cut-row-7",
				slug: "event-7",
				status: "published",
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				published_at: new Date().toISOString(),
				version: 1,
				locale: "en",
				translation_group: "cut-row-7",
				title: "Event Number 7",
				content: "[]",
			} as never)
			.execute();

		// Still stale before retry because the cut attempt never flushed its epoch bump.
		expect(await readCachedList()).toHaveLength(6);

		// Retry executes with skipExisting: true, skips all 7 rows, and returns.
		const retryRes = await callExecutePost(emdash, buildMultiPostWxr(7));
		expect(retryRes.status).toBe(200);
		const retryBody = (await retryRes.json()) as {
			data: { imported: number; skipped: number };
		};
		expect(retryBody.data.imported).toBe(0);
		expect(retryBody.data.skipped).toBe(7);
		await new Promise((r) => setTimeout(r, 20));

		// Cached list after retry now reflects the committed row from the cut attempt.
		const afterRetry = await readCachedList();
		expect(afterRetry).toHaveLength(7);
		expect(afterRetry).toContain("event-7");
	});

	it("A1: invalidates request-cached schema metadata on SchemaRegistry mutations", async () => {
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

			await registry.updateCollection("pages", { label: "Renamed Pages" });
			const afterRename = await registry.getCollectionWithFields("pages");
			expect(afterRename?.label).toBe("Renamed Pages");
		});
	});
});
