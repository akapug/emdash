import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EventEmbed from "../../../../templates/blog-cloudflare/src/components/EventEmbed.astro";
const reads = vi.hoisted(() => ({ list: vi.fn(), timezone: "UTC" }));
async function emdashReads() {
	return {
		getCollectionByUrlPattern: async () => ({ slug: "custom_meetups" }),
		getEmDashCollection: reads.list,
		getSiteSettingsWithCacheHint: async () => ({
			data: { timezone: reads.timezone },
			cacheHint: {},
		}),
	};
}
vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);
const options = {
	version: 1,
	viewSlug: "tile-a",
	mode: "upcoming",
	order: "asc",
	layout: "tile",
	start: "today",
	navigation: true,
};
const key = "events-month[tile-a]";
function entry(id: string, fields: Record<string, unknown>) {
	return { id, data: { id, title: id, status: "published", ...fields }, edit: {} };
}
async function render(url: URL, events: Record<string, unknown> = options) {
	const container = await AstroContainer.create();
	return container.renderToString(EventEmbed, {
		props: {
			node: { _type: "embed", _key: "tile", provider: "embark-events", url: "/events/", events },
		},
		request: new Request(url),
	});
}
function monthUrl(month: string) {
	const url = new URL("https://example.org/calendar/?q=one%20two");
	url.searchParams.set(key, month);
	url.searchParams.set("events-month[tile-b]", "2027-02");
	return url;
}
function navigation(html: string, rel: "prev" | "next") {
	const tag = html.match(new RegExp(`<a[^>]*rel="${rel}"[^>]*>`))?.[0];
	expect(tag, `${rel} navigation link`).toBeDefined();
	return new URL(tag!.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), "https://example.org");
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-20T00:30:00Z"));
	reads.timezone = "UTC";
	reads.list
		.mockReset()
		.mockResolvedValue({
			entries: [
				entry("december", { start_date: "2026-12-20", category: "Arts" }),
				entry("later-december", { start_date: "2026-12-25", category: "Arts" }),
				entry("other-category", { start_date: "2026-12-28", category: "Other" }),
				entry("january", { start_date: "2027-01-05", category: "Arts" }),
			],
			hasMore: false,
			cacheHint: {},
		});
});
describe("a saved tile's month navigation", () => {
	it("bounds December before applying order/filters/limit and carries independent query state into January", async () => {
		const html = await render(monthUrl("2026-12"), {
			...options,
			order: "desc",
			limit: 1,
			filters: { category: ["Arts"] },
		});
		expect(html).toContain("/events/later-december/");
		for (const slug of ["december", "january", "other-category"])
			expect(html).not.toContain(`/events/${slug}/`);
		const next = navigation(html, "next");
		const prev = navigation(html, "prev");
		expect(next.pathname).toBe("/calendar/");
		expect(next.searchParams.get(key)).toBe("2027-01");
		expect(prev.searchParams.get(key)).toBe("2026-11");
		for (const link of [next, prev]) {
			expect(link.searchParams.get("q")).toBe("one two");
			expect(link.searchParams.get("events-month[tile-b]")).toBe("2027-02");
		}
	});
	it("moves January back into December without leaking December entries into January", async () => {
		const html = await render(monthUrl("2027-01"));
		expect(html).toContain("/events/january/");
		expect(html).not.toContain("/events/december/");
		expect(navigation(html, "prev").searchParams.get(key)).toBe("2026-12");
		expect(navigation(html, "next").searchParams.get(key)).toBe("2027-02");
	});
	it("fails visibly before content reads for malformed or duplicate months", async () => {
		for (const month of ["2026-13", "2026-1", "0000-01", "2026-12-extra", ""]) {
			const html = await render(monthUrl(month));
			expect(html).toContain("Saved event view unavailable");
		}
		const duplicate = monthUrl("2026-12");
		duplicate.searchParams.append(key, "2027-01");
		expect(await render(duplicate)).toContain("Saved event view unavailable");
		expect(reads.list).not.toHaveBeenCalled();
	});
	it("anchors the default month to the existing site's source timezone at a UTC month boundary", async () => {
		vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));
		reads.timezone = "America/Los_Angeles";
		reads.list.mockResolvedValue({
			entries: [
				entry("last-evening", { start_date: "2026-11-30" }),
				entry("first-december", { start_date: "2026-12-01" }),
			],
			hasMore: false,
			cacheHint: {},
		});
		const html = await render(new URL("https://example.org/calendar/"));
		expect(html).toContain("2026-11");
		expect(html).toContain("/events/last-evening/");
		expect(html).not.toContain("/events/first-december/");
	});
	it("projects a future preview into the requested month rather than losing it behind an earlier occurrence", async () => {
		reads.list.mockResolvedValue({
			entries: [
				entry("series", {
					start_date: "2020-01-01",
					occurrences: '["2026-11-25","2026-12-12","2027-01-10"]',
				}),
			],
			hasMore: false,
			cacheHint: {},
		});
		const html = await render(monthUrl("2026-12"));
		expect(html).toContain("/events/series/");
		expect(html).toContain("2026-12-12");
		expect(html).not.toContain("2026-11-25");
		expect(html).toContain("Recurrence preview");
	});
	it("navigation never widens upcoming/past or current-month start semantics, and false remains non-navigating", async () => {
		reads.list.mockResolvedValue({
			entries: [
				entry("past-october", { start_date: "2026-10-20" }),
				entry("past-november", { start_date: "2026-11-10" }),
				entry("future", { start_date: "2026-11-25" }),
			],
			hasMore: false,
			cacheHint: {},
		});
		const past = await render(monthUrl("2026-10"), {
			...options,
			mode: "past",
			start: "start_current_month",
		});
		expect(past).toContain("/events/past-october/");
		expect(past).not.toContain("/events/future/");
		expect(
			await render(monthUrl("2026-11"), { ...options, mode: "past", start: "start_current_month" }),
		).not.toContain("/events/past-november/");
		const disabled = await render(monthUrl("malformed"), { ...options, navigation: false });
		expect(disabled).toContain("/events/future/");
		expect(disabled).not.toContain('rel="next"');
	});
});
