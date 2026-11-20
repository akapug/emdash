import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as execute } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { POST as prepare } from "../../../src/astro/routes/api/import/wordpress/prepare.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const standardFields = [
	{ slug: "title", label: "Title", type: "string", required: true },
	{ slug: "content", label: "Content", type: "portableText", required: false },
	{ slug: "excerpt", label: "Excerpt", type: "text", required: false },
	{ slug: "featured_image", label: "Cover", type: "image", required: false },
];
const eventFields = [
	{ slug: "start_date", label: "Start", type: "string", required: true },
	...[
		"end_date",
		"start_time",
		"end_time",
		"timezone",
		"location",
		"organizer",
		"category",
		"cost",
		"more_info",
		"more_info_title",
		"event_status",
		"cancelled_reason",
		"time_note",
	].map((slug) => ({ slug, label: slug, type: "string", required: false })),
	{ slug: "all_day", label: "All day", type: "boolean", required: false },
	{ slug: "occurrences", label: "Occurrences", type: "json", required: false },
];
const IMAGE = "https://example.org/cover.png";
const item = (id: number, type = "mec-events") => `<item>
	<title>Entry ${id}</title><wp:post_id>${id}</wp:post_id>
	<wp:post_type>${type}</wp:post_type><wp:post_name>entry-${id}</wp:post_name>
	<wp:status>publish</wp:status><wp:post_date_gmt>2026-01-15 08:30:00</wp:post_date_gmt>
	<content:encoded><![CDATA[<p>Body ${id}</p>]]></content:encoded>
	<excerpt:encoded>Excerpt ${id}</excerpt:encoded>
	<wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>100</wp:meta_value></wp:postmeta>
</item>`;
const wxr = (items = item(7) + item(8) + item(9, "post")) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/">
<channel><title>Synthetic events</title><link>https://example.org</link>
<item><wp:post_id>100</wp:post_id><wp:post_type>attachment</wp:post_type><wp:attachment_url>${IMAGE}</wp:attachment_url></item>
${items}</channel></rss>`;
const firstEvent = {
	start_date: "2026-12-01",
	end_date: "2026-12-02",
	start_time: "09:00",
	end_time: "10:00",
	timezone: "Europe/London",
	location: "Hall",
	organizer: "Garden club",
	category: "Talk",
	cost: "Free",
	more_info: "https://example.org/details",
	more_info_title: "Details",
	event_status: "cancelled",
	cancelled_reason: "Weather",
	all_day: true,
	occurrences: ["2026-12-01", "2026-12-08"],
};
const secondEvent = {
	start_date: "2027-01-05",
	all_day: false,
	occurrences: ["2027-01-05"],
	time_note: "After sunset",
};

describe("WXR mapped fields at the original content mutation", () => {
	let db: Kysely<Database>;
	let emdash: EmDashHandlers;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		emdash = handlersFromRuntime(createTestRuntime(db));
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function prepareCollection(collection = "mec_events", fields = eventFields) {
		const request = new Request("http://localhost/_emdash/api/import/wordpress/prepare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				postTypes: [{ name: "mec-events", collection, fields: [...standardFields, ...fields] }],
			}),
		});
		return prepare({
			request,
			locals: { emdash, user: { id: "operator", role: Role.ADMIN } },
		} as Parameters<typeof prepare>[0]);
	}
	async function run(mappedFields: unknown, collection = "mec_events", items?: string) {
		const config = {
			postTypeMappings: {
				"mec-events": { collection, enabled: true },
				post: { collection: "posts", enabled: true },
			},
			skipExisting: true,
			importSections: false,
			locale: "en",
			...(mappedFields === undefined ? {} : { mappedFields }),
		};
		const form = new FormData();
		form.set("file", new File([wxr(items)], "synthetic.xml", { type: "application/xml" }));
		form.set("config", JSON.stringify(config));
		return execute({
			request: new Request("http://localhost/_emdash/api/import/wordpress/execute", {
				method: "POST",
				body: form,
			}),
			locals: { emdash, user: { id: "operator", role: Role.ADMIN } },
		} as Parameters<typeof execute>[0]);
	}
	async function rows(collection = "mec_events"): Promise<Record<string, unknown>[]> {
		return db
			.selectFrom(`ec_${collection}` as keyof Database)
			.selectAll()
			.orderBy("slug" as never)
			.execute() as Promise<Record<string, unknown>[]>;
	}

	it("stores each source ID's native event fields in its first row and first revision, preserving ordinary content", async () => {
		expect((await prepareCollection()).status).toBe(200);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		for (const field of standardFields) {
			await registry.createField("posts", {
				...field,
				type: field.type as "string" | "portableText" | "text" | "image",
			});
		}
		const response = await run({ "7": firstEvent, "8": secondEvent });
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({
			success: true,
			imported: 3,
			skipped: 0,
			errors: [],
			byCollection: { mec_events: 2, posts: 1 },
		});
		const events = await rows();
		for (const [index, fields] of [firstEvent, secondEvent].entries()) {
			const row = events[index]!;
			expect(row).toMatchObject({
				slug: `entry-${7 + index}`,
				title: `Entry ${7 + index}`,
				excerpt: `Excerpt ${7 + index}`,
				status: "published",
				locale: "en",
				start_date: fields.start_date,
				all_day: fields.all_day ? 1 : 0,
				created_at: "2026-01-15T08:30:00.000Z",
				published_at: "2026-01-15T08:30:00.000Z",
			});
			expect(JSON.parse(row.content as string)).toEqual(
				expect.arrayContaining([expect.objectContaining({ _type: "block" })]),
			);
			expect(JSON.parse(row.occurrences as string)).toEqual(fields.occurrences);
			expect(JSON.parse(row.featured_image as string)).toMatchObject({
				provider: "external",
				src: IMAGE,
			});
			// Create does not snapshot; native publish materializes the first revision from the row.
			expect((await emdash.handleContentPublish("mec_events", row.id as string)).success).toBe(
				true,
			);
			const revisions = await db
				.selectFrom("revisions")
				.selectAll()
				.where("entry_id", "=", row.id as string)
				.execute();
			expect(revisions).toHaveLength(1);
			expect(JSON.parse(revisions[0]!.data)).toMatchObject({
				...fields,
				all_day: fields.all_day ? 1 : 0,
			});
		}
		expect(events[1]).toMatchObject({
			time_note: "After sunset",
			start_time: null,
			end_time: null,
		});
		expect(events[0]).toMatchObject({
			event_status: "cancelled",
			cancelled_reason: "Weather",
			location: "Hall",
			end_date: "2026-12-02",
			start_time: "09:00",
			end_time: "10:00",
			timezone: "Europe/London",
			organizer: "Garden club",
			category: "Talk",
			cost: "Free",
			more_info: "https://example.org/details",
			more_info_title: "Details",
		});
		const post = (await rows("posts"))[0]!;
		expect(post).toMatchObject({ title: "Entry 9", status: "published" });
		expect(JSON.parse(post.featured_image as string)).toMatchObject({ src: IMAGE });
		const again = await run({ "7": { ...firstEvent, location: "Changed" }, "8": secondEvent });
		expect((await again.json()).data).toMatchObject({
			success: true,
			imported: 0,
			skipped: 3,
			errors: [],
		});
		expect((await rows())[0]!.location).toBe("Hall");
		expect(await db.selectFrom("revisions").selectAll().execute()).toHaveLength(2);
	});

	it("keeps imports without mappedFields compatible with ordinary posts", async () => {
		const request = new Request("http://localhost/_emdash/api/import/wordpress/prepare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				postTypes: [{ name: "post", collection: "posts", fields: standardFields }],
			}),
		});
		expect(
			(
				await prepare({
					request,
					locals: { emdash, user: { id: "operator", role: Role.ADMIN } },
				} as Parameters<typeof prepare>[0])
			).status,
		).toBe(200);
		const response = await run(undefined, "mec_events", item(9, "post"));
		expect((await response.json()).data).toMatchObject({ success: true, imported: 1, errors: [] });
		expect((await rows("posts"))[0]).toMatchObject({ title: "Entry 9", status: "published" });
	});

	it.each([
		["missing start", {}],
		["invalid date", { start_date: "2026-02-30" }],
		["datetime instead of date", { start_date: "2026-12-01T00:00:00Z" }],
		["invalid end date", { ...firstEvent, end_date: "2026-02-30" }],
		["non-string location", { ...firstEvent, location: 42 }],
		["non-string time note", { ...firstEvent, time_note: true }],
		["truthy string", { ...firstEvent, all_day: "false" }],
		["numeric boolean", { ...firstEvent, all_day: 1 }],
		["CSV recurrence", { ...firstEvent, occurrences: "2026-12-01,2026-12-08" }],
		["invalid recurrence", { ...firstEvent, occurrences: ["2026-02-30"] }],
		["unknown field", { ...firstEvent, unregistered: "lost" }],
		...[
			"status",
			"slug",
			"locale",
			"translation_group",
			"authorId",
			"publishedAt",
			"_rev",
			"title",
			"content",
			"excerpt",
			"featured_image",
		].map((key) => [key, { ...firstEvent, [key]: "override" }]),
	])("rejects %s without creating a malformed row or revision", async (_name, fields) => {
		expect((await prepareCollection()).status).toBe(200);
		const response = await run({ "7": fields }, "mec_events", item(7));
		const body = await response.json();
		expect(response.status === 400 || body.data?.success === false).toBe(true);
		expect(JSON.stringify(body)).toMatch(
			/invalid|reserved|unknown|collision|start_date|all_day|occurrences/i,
		);
		expect(await rows()).toEqual([]);
		expect(await db.selectFrom("revisions").selectAll().execute()).toEqual([]);
	});

	it.each(
		[null, [], "bad", { "7": [] }, { "7": null }, { "7": "bad" }, { wrong: firstEvent }].map(
			(map) => ({ map }),
		),
	)("rejects malformed maps before any content mutation: $map", async ({ map }) => {
		expect((await prepareCollection()).status).toBe(200);
		const response = await run(map, "mec_events", item(7));
		expect(response.status).toBe(400);
		expect(await rows()).toEqual([]);
	});

	it("prepares an ordinary collection when optional fields are absent", async () => {
		const request = new Request("http://localhost/_emdash/api/import/wordpress/prepare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ postTypes: [{ name: "post", collection: "posts" }] }),
		});
		const response = await prepare({
			request,
			locals: { emdash, user: { id: "operator", role: Role.ADMIN } },
		} as Parameters<typeof prepare>[0]);
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({ success: true, errors: [] });
	});

	it.each(["mec_events", "community_calendar"])(
		"prepares the actual mapped collection %s with discoverable URL metadata even when empty",
		async (collection) => {
			const response = await prepareCollection(collection);
			expect(response.status).toBe(200);
			expect(await registry.getCollection(collection)).toMatchObject({
				slug: collection,
				urlPattern: "/events/{slug}",
			});
			expect(await registry.getCollection("events")).toBeNull();
			expect(await rows(collection)).toEqual([]);
			expect((await prepareCollection(collection)).status).toBe(200);
		},
	);

	it("repairs absent URL metadata on an existing mapped collection and invalidates routing", async () => {
		await registry.createCollection({
			slug: "community_calendar",
			label: "Calendar",
			labelSingular: "Event",
		});
		let invalidations = 0;
		emdash.invalidateUrlPatternCache = () => {
			invalidations++;
		};
		expect((await prepareCollection("community_calendar")).status).toBe(200);
		expect(await registry.getCollection("community_calendar")).toMatchObject({
			urlPattern: "/events/{slug}",
		});
		expect(invalidations).toBe(1);
	});

	it("surfaces an explicit operator route conflict without replacing it", async () => {
		await registry.createCollection({
			slug: "community_calendar",
			label: "Calendar",
			labelSingular: "Event",
			urlPattern: "/calendar/{slug}",
		});
		const response = await prepareCollection("community_calendar");
		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toMatch(/url|pattern|route/i);
		expect(await registry.getCollection("community_calendar")).toMatchObject({
			urlPattern: "/calendar/{slug}",
		});
	});

	it("rejects a datetime-backed event date even when execute bypasses prepare", async () => {
		expect(
			(
				await prepareCollection(
					"mec_events",
					eventFields.filter((field) => field.slug !== "start_date"),
				)
			).status,
		).toBe(200);
		await registry.createField("mec_events", {
			slug: "start_date",
			label: "Start",
			type: "datetime",
			required: true,
		});
		const response = await run({ "7": firstEvent }, "mec_events", item(7));
		expect((await response.json()).data).toMatchObject({ success: false, imported: 0 });
		expect(await rows()).toEqual([]);
	});

	it.each(["datetime", "string"] as const)(
		"surfaces an incompatible existing %s event field instead of claiming preparation succeeded",
		async (type) => {
			await registry.createCollection({
				slug: "mec_events",
				label: "Calendar",
				labelSingular: "Event",
			});
			await registry.createField("mec_events", { slug: "start_date", label: "Start", type });
			const response = await prepareCollection();
			expect(response.status).toBe(400);
			expect(JSON.stringify(await response.json())).toMatch(/start_date/);
		},
	);
});
