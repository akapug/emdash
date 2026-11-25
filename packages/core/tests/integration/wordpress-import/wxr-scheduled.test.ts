/**
 * Real integration tests for WordPress `future` / `private` / `pending` posts
 * through `importContent` + `handleContentSchedule` + real SQLite DB (emb/142).
 *
 * Proves:
 * - `future` + zoned `post_date_gmt` ahead -> `status: 'scheduled'` with `scheduled_at`
 * - `future` + zoned `pubDate` ahead -> `status: 'scheduled'` with `scheduled_at`
 * - `future` + zoned `post_date_gmt` in the past -> `status: 'published'` (missed schedule)
 * - `future` + unzoned local `post_date` ONLY -> stays `draft`, `scheduled_at: null`, named in `result.errors`
 * - `future` + `0000-00-00` or unparseable `post_date_gmt` -> stays `draft`, NEVER published
 * - `private` / `pending` -> stay `draft`, never published
 * - Failed `handleContentSchedule` leaves the row as a real `draft` (not `scheduled` with `scheduled_at = NULL`)
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	importContent,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function wxrItem(opts: {
	id: number;
	slug: string;
	status: string;
	postDateGmt?: string;
	pubDate?: string;
	postDate?: string;
}): string {
	return `
    <item>
      <title><![CDATA[${opts.slug}]]></title>
      <link>https://example.org/${opts.slug}/</link>
      ${opts.pubDate !== undefined ? `<pubDate>${opts.pubDate}</pubDate>` : ""}
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[<p>Body of ${opts.slug}.</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>${opts.id}</wp:post_id>
      ${opts.postDate !== undefined ? `<wp:post_date><![CDATA[${opts.postDate}]]></wp:post_date>` : ""}
      ${opts.postDateGmt !== undefined ? `<wp:post_date_gmt><![CDATA[${opts.postDateGmt}]]></wp:post_date_gmt>` : ""}
      <wp:post_name><![CDATA[${opts.slug}]]></wp:post_name>
      <wp:status><![CDATA[${opts.status}]]></wp:status>
      <wp:post_type><![CDATA[post]]></wp:post_type>
    </item>`;
}

function wrapWxr(items: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Schedule</title>
    <link>https://example.org</link>
    ${items.join("\n")}
  </channel>
</rss>`;
}

describe("WXR import: scheduled, missed-schedule, unzoned, invalid, private, pending (emb/142)", () => {
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

	async function runImport(xml: string) {
		const wxr = await parseWxrString(xml);
		const plan = await preImportWxrTaxonomies(db, wxr.posts, wxr.categories, wxr.tags, wxr.terms);
		const config: ImportConfig = {
			postTypeMappings: { post: { collection: "posts", enabled: true } },
			skipExisting: true,
		};
		return importContent(
			wxr.posts,
			config,
			emdash,
			await emdash.getManifest(),
			new Map(),
			undefined,
			undefined,
			plan,
			undefined,
			wxr.site.language,
		);
	}

	it("schedules zoned future posts, publishes missed schedules, and keeps unzoned/invalid/private/pending as draft", async () => {
		const xml = wrapWxr([
			wxrItem({
				id: 1,
				slug: "ahead-gmt",
				status: "future",
				postDateGmt: "2099-05-01 10:00:00",
				postDate: "2099-05-01 06:00:00",
			}),
			wxrItem({
				id: 2,
				slug: "ahead-pubdate",
				status: "future",
				postDateGmt: "0000-00-00 00:00:00",
				pubDate: "Fri, 01 May 2099 10:00:00 -0400",
				postDate: "2099-05-01 10:00:00",
			}),
			wxrItem({
				id: 3,
				slug: "missed-schedule",
				status: "future",
				postDateGmt: "2020-01-15 10:00:00",
			}),
			wxrItem({
				id: 4,
				slug: "unzoned-local-only",
				status: "future",
				postDateGmt: "0000-00-00 00:00:00",
				postDate: "2099-05-01 10:00:00",
			}),
			wxrItem({
				id: 5,
				slug: "invalid-gmt",
				status: "future",
				postDateGmt: "not-a-real-date",
			}),
			wxrItem({
				id: 6,
				slug: "zero-date",
				status: "future",
				postDateGmt: "0000-00-00 00:00:00",
				postDate: "0000-00-00 00:00:00",
			}),
			wxrItem({
				id: 7,
				slug: "private-note",
				status: "private",
				postDateGmt: "2020-01-15 10:00:00",
			}),
			wxrItem({
				id: 8,
				slug: "pending-review",
				status: "pending",
				postDateGmt: "2020-01-15 10:00:00",
			}),
		]);

		const result = await runImport(xml);
		const repo = new ContentRepository(db);
		const bySlug = async (slug: string) => (await repo.findBySlug("posts", slug))!;

		const aheadGmt = await bySlug("ahead-gmt");
		expect(aheadGmt.status).toBe("scheduled");
		expect(aheadGmt.scheduledAt).toBe("2099-05-01T10:00:00.000Z");

		const aheadPub = await bySlug("ahead-pubdate");
		expect(aheadPub.status).toBe("scheduled");
		expect(aheadPub.scheduledAt).toBe("2099-05-01T14:00:00.000Z");

		const missed = await bySlug("missed-schedule");
		expect(missed.status).toBe("published");
		expect(missed.scheduledAt).toBeNull();

		const unzoned = await bySlug("unzoned-local-only");
		expect(unzoned.status).toBe("draft");
		expect(unzoned.scheduledAt).toBeNull();
		expect(
			result.errors.some(
				(e) => e.title === "unzoned-local-only" && /no timezone/i.test(e.error),
			),
		).toBe(true);

		const invalidGmt = await bySlug("invalid-gmt");
		expect(invalidGmt.status).toBe("draft");
		expect(invalidGmt.scheduledAt).toBeNull();

		const zeroDate = await bySlug("zero-date");
		expect(zeroDate.status).toBe("draft");
		expect(zeroDate.scheduledAt).toBeNull();

		const priv = await bySlug("private-note");
		expect(priv.status).toBe("draft");

		const pend = await bySlug("pending-review");
		expect(pend.status).toBe("draft");
	});

	it("never creates a scheduled item as published and keeps it a real draft if handleContentSchedule fails", async () => {
		const createStatuses: string[] = [];
		const origCreate = emdash.handleContentCreate.bind(emdash);
		emdash.handleContentCreate = async (collection, input) => {
			createStatuses.push(String(input.status));
			return origCreate(collection, input);
		};

		const origSchedule = emdash.handleContentSchedule.bind(emdash);
		emdash.handleContentSchedule = async (collection, id, scheduledAt) => {
			const row = await new ContentRepository(db).findById(collection, id);
			if (row?.slug === "sched-fail") {
				throw new Error("Simulated schedule rejection");
			}
			return origSchedule(collection, id, scheduledAt);
		};

		const xml = wrapWxr([
			wxrItem({
				id: 10,
				slug: "sched-ok",
				status: "future",
				postDateGmt: "2099-06-01 12:00:00",
			}),
			wxrItem({
				id: 11,
				slug: "sched-fail",
				status: "future",
				postDateGmt: "2099-06-02 12:00:00",
			}),
		]);

		const result = await runImport(xml);
		expect(createStatuses).toEqual(["draft", "draft"]);

		const repo = new ContentRepository(db);
		const okRow = (await repo.findBySlug("posts", "sched-ok"))!;
		expect(okRow.status).toBe("scheduled");
		expect(okRow.scheduledAt).toBe("2099-06-01T12:00:00.000Z");

		const failRow = (await repo.findBySlug("posts", "sched-fail"))!;
		expect(failRow.status).toBe("draft");
		expect(failRow.scheduledAt).toBeNull();
		expect(
			result.errors.some(
				(e) => e.title === "sched-fail" && /Simulated schedule rejection/.test(e.error),
			),
		).toBe(true);
	});
});
