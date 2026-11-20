import { describe, expect, it, vi, beforeEach } from "vitest";

import {
	loadEvent,
	loadEvents,
} from "../../../../../templates/blog-cloudflare/src/utils/event-data.js";
import {
	eventSummary,
	parseEventView,
	selectEventView,
	type EventEntry,
} from "../../../../../templates/blog-cloudflare/src/utils/events.js";
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
