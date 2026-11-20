import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
	loadEvent,
	loadEvents,
} from "../../../../../templates/blog-cloudflare/src/utils/event-data.js";
import {
	eventSummary,
	eventPage,
	formatEventDate,
	formatEventMonth,
	formatEventTimes,
	parseEventView,
	selectEventView,
	type EventEntry,
} from "../../../../../templates/blog-cloudflare/src/utils/events.js";
import { handleContentCreate } from "../../../src/api/index.js";
import { emdashLoader } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";
const reads = vi.hoisted(() => ({ schema: vi.fn(), list: vi.fn(), entry: vi.fn() }));
vi.mock("emdash", () => ({
	getCollectionByUrlPattern: reads.schema,
	getEmDashCollection: reads.list,
	getEmDashEntry: reads.entry,
}));
function entry(id: string, fields: Record<string, unknown> = {}): EventEntry {
	return {
		id,
		data: { id, title: id, status: "published", start_date: "2026-11-21", ...fields },
		edit: {} as EventEntry["edit"],
	};
}
const now = new Date("2026-11-20T00:30:00Z");
const wire = {
	version: 1,
	viewSlug: "example",
	mode: "upcoming",
	order: "asc",
	layout: "list",
	start: "today",
};
beforeEach(() => {
	reads.schema.mockReset().mockResolvedValue({ slug: "custom_meetups" });
	reads.list.mockReset().mockResolvedValue({ entries: [], hasMore: false, cacheHint: {} });
	reads.entry.mockReset();
});
describe("human event dates and clocks", () => {
	it("formats civil dates in the actual locale, including WordPress locale separators", () => {
		expect(formatEventDate("2026-11-20", "en_US")).toBe("Fri, Nov 20, 2026");
		expect(formatEventDate("2026-11-20", "fr-FR")).toBe("ven. 20 nov. 2026");
		expect(formatEventDate("2026-12-01", "en-US")).toBe("Tue, Dec 1, 2026");
		expect(formatEventDate("2026-02-30", "en-US")).toBe("2026-02-30");
	});
	it("formats the navigation month without changing its query identity", () => {
		expect(formatEventMonth("2026-11", "en-US")).toBe("November 2026");
		expect(formatEventMonth("2026-11", "fr-FR")).toBe("novembre 2026");
	});
	it("uses locale clocks rather than forcing a twelve-hour or twenty-four-hour cycle", () => {
		const times = { startTime: "19:00", endTime: "21:00" };
		expect(formatEventTimes(times, "en-US")?.replace(/\s+/g, " ")).toBe("7:00 – 9:00 PM");
		expect(formatEventTimes(times, "en-GB")).toMatch(/^19:00\s*–\s*21:00$/);
	});
	it("keeps overnight clocks and missing endpoints honest without inventing a date", () => {
		expect(formatEventTimes({ startTime: "22:30", endTime: "01:15" }, "en-US")).toBe(
			"10:30 PM – 1:15 AM",
		);
		expect(formatEventTimes({ startTime: "00:00" }, "en-US")).toBe("12:00 AM");
		expect(formatEventTimes({ endTime: "21:00" }, "en-US")).toBe("Until 9:00 PM");
	});
	it("shows no clock for all-day, absent, invalid or prose-only times", () => {
		expect(formatEventTimes({ allDay: true, startTime: "19:00" }, "en-US")).toBeUndefined();
		expect(formatEventTimes({}, "en-US")).toBeUndefined();
		expect(formatEventTimes({ startTime: "Doors at dusk" }, "en-US")).toBeUndefined();
		const noted = eventSummary(entry("noted", { time_note: "Doors at dusk" }), now)!;
		expect(formatEventTimes(noted, "en-US")).toBeUndefined();
	});
	it("does not rewrite source clocks/dates or turn a reference zone into a display zone", () => {
		const event = eventSummary(
			entry("civil", { start_time: "19:00" }),
			now,
			undefined,
			"Asia/Tokyo",
		)!;
		expect(formatEventDate(event.date, "en-US")).toBe("Sat, Nov 21, 2026");
		expect(formatEventTimes(event, "en-US")).toBe("7:00 PM");
		expect(event.date).toBe("2026-11-21");
		expect(event.startTime).toBe("19:00");
		expect(event.timezone).toBeUndefined();
	});
});

describe("event result pages", () => {
	const events = ["first", "second", "third"].map((id) => eventSummary(entry(id), now)!);
	it("pages the selected order and retains independent query state without mutating the URL", () => {
		const url = new URL(
			"https://example.org/past-events/?q=one%20two&events-page[other]=3#schedule",
		);
		const first = eventPage(events, "past", url, 2)!;
		expect(first.events.map((event) => event.entry.id)).toEqual(["first", "second"]);
		expect(first.prev).toBeUndefined();
		const next = new URL(first.next!, url);
		expect(next.pathname).toBe("/past-events/");
		expect(next.searchParams.get("events-page[past]")).toBe("2");
		expect(next.searchParams.get("events-page[other]")).toBe("3");
		expect(next.searchParams.get("q")).toBe("one two");
		expect(next.hash).toBe("#schedule");
		expect(url.searchParams.has("events-page[past]")).toBe(false);
		const last = eventPage(events, "past", next, 2)!;
		expect(last.events.map((event) => event.entry.id)).toEqual(["third"]);
		expect(last.next).toBeUndefined();
		expect(new URL(last.prev!, url).searchParams.has("events-page[past]")).toBe(false);
	});
	it("does not widen an explicit saved view limit to fill a page", () => {
		const selected = selectEventView(events, parseEventView({ ...wire, limit: 2 })!, now);
		const url = new URL("https://example.org/upcoming/?events-page[example]=2");
		const page = eventPage(selected, "example", url, 1)!;
		expect(page.events.map((event) => event.entry.id)).toEqual(["second"]);
		expect(page.next).toBeUndefined();
	});
	it("uses bounded native page sizes and keeps an empty first page valid", () => {
		const many = Array.from({ length: 60 }, () => events[0]!);
		const url = new URL("https://example.org/events/");
		expect(eventPage(many, "index", url, 1000)?.events).toHaveLength(50);
		expect(eventPage(many, "index", url, Number.NaN)?.events).toHaveLength(10);
		expect(eventPage([], "index", url)?.events).toEqual([]);
	});
	it("rejects invalid, duplicate and out-of-range pages", () => {
		for (const query of [
			"0",
			"-1",
			"1.5",
			"02",
			"",
			"4",
			"99999999999999999999",
			"1&events-page[past]=2",
		]) {
			expect(
				eventPage(
					events,
					"past",
					new URL(`https://example.org/past-events/?events-page[past]=${query}`),
					1,
				),
			).toBeNull();
		}
	});
});

describe("native event locale contract", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabaseWithCollections>>;
	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});
	it("reads the actual native database row locale through the live loader", async () => {
		const created = await handleContentCreate(db, "post", {
			data: { title: "Native locale contract" },
			status: "published",
			locale: "fr-FR",
		});
		expect(created.success).toBe(true);
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", locale: "fr-FR" } }),
		);
		expect(result.entries).toHaveLength(1);
		expect(result.entries![0]!.data.locale).toBe("fr-FR");
	});
});

describe("event data trust boundaries", () => {
	it("does not coerce saved view fields into supported enum values", () => {
		expect(parseEventView({ ...wire, mode: { toString: () => "upcoming" } })).toBeNull();
		expect(parseEventView({ ...wire, filters: { category: [false] } })).toBeNull();
	});
	it("normalizes only booleans and stored boolean integers", () => {
		for (const all_day of [true, 1]) {
			const event = eventSummary(entry("all-day", { all_day, start_time: "17:30" }), now)!;
			expect(event.allDay).toBe(true);
			expect(event.startTime).toBeUndefined();
		}
		for (const all_day of ["true", "false", 2, -1, null])
			expect(eventSummary(entry("other", { all_day }), now)?.allDay).toBeUndefined();
	});
	it("does not invent absent clocks, zones or preview recurrence rules", () => {
		const plain = eventSummary(entry("plain"), now)!;
		expect(plain.startTime).toBeUndefined();
		expect(plain.endTime).toBeUndefined();
		expect(plain.timezone).toBeUndefined();
		expect(plain.preview).toBe(false);
		expect(eventSummary(entry("empty-preview", { occurrences: "[]" }), now)?.period).toBe(
			"preview",
		);
		expect(eventSummary(entry("bad-preview", { occurrences: '["2026-11-31"]' }), now)).toBeNull();
	});
	it("supports ongoing multi-day events without moving the source start date", () => {
		const event = eventSummary(
			entry("ongoing", { start_date: "2026-11-18", end_date: "2026-11-22" }),
			now,
		)!;
		expect(event.date).toBe("2026-11-18");
		expect(event.period).toBe("upcoming");
	});
	it("matches hydrated term labels, not slugs or substrings, with AND between filters", () => {
		const events = [
			entry("yes", {
				location: "Main Hall",
				terms: { category: [{ label: "Fine Arts", slug: "fine-arts" }] },
			}),
			entry("no", { location: "Annex", category: "Fine Arts" }),
		].map((e) => eventSummary(e, now)!);
		const view = parseEventView({
			...wire,
			filters: { category: ["Fine Arts"], location: ["Main Hall"] },
		})!;
		expect(selectEventView(events, view, now).map((e) => e.entry.id)).toEqual(["yes"]);
		expect(selectEventView(events, { ...view, filters: { category: ["fine-arts"] } }, now)).toEqual(
			[],
		);
	});
	it("publishes no draft or archived content even if a caller passes such rows", () => {
		for (const status of ["draft", "archived"])
			expect(eventSummary(entry(status, { status }), now)).toBeNull();
	});
	it("selects the schema URL pattern identity and carries publication/locale filters through every page", async () => {
		reads.list
			.mockResolvedValueOnce({
				entries: [entry("first")],
				hasMore: true,
				nextCursor: "next",
				cacheHint: { tags: ["one"] },
			})
			.mockResolvedValueOnce({
				entries: [entry("second")],
				hasMore: false,
				cacheHint: { tags: ["two"] },
			});
		const result = await loadEvents("fr");
		expect(result.entries.map((e) => e.id)).toEqual(["first", "second"]);
		expect(result.hints).toEqual([{ tags: ["one"] }, { tags: ["two"] }]);
		expect(reads.schema).toHaveBeenCalledWith("/events/{slug}");
		for (const [collection, filter] of reads.list.mock.calls) {
			expect(collection).toBe("custom_meetups");
			expect(filter).toMatchObject({ status: "published", locale: "fr" });
		}
	});
	it("does not treat a broken, cyclic or bounded scan as a complete next-events listing", async () => {
		for (const page of [
			{ entries: [entry("one")], hasMore: true, cacheHint: {} },
			{ entries: [entry("one")], hasMore: true, nextCursor: "same", cacheHint: {} },
			{ entries: [], error: new Error("not readable"), cacheHint: {} },
		]) {
			reads.list.mockResolvedValue(page);
			expect(await loadEvents()).toMatchObject({ entries: [], unavailable: true });
		}
		let i = 0;
		reads.list.mockImplementation(async () => ({
			entries: [entry(String(i))],
			hasMore: true,
			nextCursor: `page${i++}`,
			cacheHint: {},
		}));
		expect(await loadEvents()).toMatchObject({ entries: [], unavailable: true });
		expect(i).toBe(50);
	});
	it("a missing collection is empty, and never guesses an events table", async () => {
		reads.schema.mockResolvedValue(null);
		expect(await loadEvents()).toMatchObject({ entries: [], unavailable: false });
		expect(reads.list).not.toHaveBeenCalled();
	});
	it("keeps an ambiguous schema explicit and refuses draft preview detail", async () => {
		reads.schema.mockRejectedValueOnce(new Error("Ambiguous URL pattern"));
		await expect(loadEvents()).rejects.toThrow("Ambiguous URL pattern");
		reads.entry.mockResolvedValue({ entry: entry("preview"), isPreview: true, cacheHint: {} });
		expect(await loadEvent("preview", "fr")).toBeNull();
		reads.entry.mockResolvedValue({ entry: entry("draft", { status: "draft" }), cacheHint: {} });
		expect(await loadEvent("draft", "fr")).toBeNull();
	});
});
