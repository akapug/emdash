import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import EventList from "../../../../templates/blog-cloudflare/src/components/EventList.astro";
import { parseEventView } from "../../../../templates/blog-cloudflare/src/utils/events.js";

async function emdashReads() {
	return {
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Example", timezone: "America/New_York", postsPerPage: 10 },
			cacheHint: { tags: ["settings"] },
		}),
	};
}
vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);

const now = new Date("2026-11-23T12:00:00Z");

function makeEvent(
	slug: string,
	title: string,
	start_date: string,
	extra: Record<string, unknown> = {},
) {
	return {
		id: slug,
		data: {
			id: `ID-${slug}`,
			status: "published",
			title,
			locale: "en-US",
			start_date,
			...extra,
		},
		edit: { title: {}, content: {} },
	};
}

describe("MEC event search bar (text + month + year no-JS GET form, item 108)", () => {
	const pastView = parseEventView({
		version: 1,
		viewSlug: "old-events",
		mode: "past",
		order: "desc",
		layout: "list",
		start: "start_current_month",
		searchBar: { text: true, monthYear: true },
	})!;

	const entries = [
		makeEvent("salsa-2026-10", "Fall Salsa Dance Series", "2026-10-15", { location: "Main Hall" }),
		makeEvent("yoga-2026-05", "Spring Yoga Workshop", "2026-05-10", { organizer: "Alice Rivera" }),
		makeEvent("concert-2025-10", "Autumn Jazz Concert", "2025-10-20", { location: "Barn Stage" }),
	];

	it("validates searchBar strictly and fails closed on empty or unknown keys", () => {
		expect(pastView).not.toBeNull();
		expect(parseEventView({ ...pastView, searchBar: {} })).toBeNull();
		expect(
			parseEventView({ ...pastView, searchBar: { text: false, monthYear: false } }),
		).toBeNull();
		expect(parseEventView({ ...pastView, searchBar: { category: true } })).toBeNull();
	});

	it("renders a no-JS GET form with text search, Month, and Year selects and filters by each param", async () => {
		const container = await AstroContainer.create();
		const baseHtml = await container.renderToString(EventList, {
			props: { entries, view: pastView, now },
			request: new Request("https://example.org/past-events/"),
		});
		expect(baseHtml).toContain('<form method="get" action="/past-events/"');
		expect(baseHtml).toContain('name="events-q[old-events]"');
		expect(baseHtml).toContain('name="events-month-num[old-events]"');
		expect(baseHtml).toContain('name="events-year[old-events]"');
		expect(baseHtml).toContain(">2026</option>");
		expect(baseHtml).toContain(">2025</option>");
		expect(baseHtml).toContain("Fall Salsa Dance Series");
		expect(baseHtml).toContain("Spring Yoga Workshop");
		expect(baseHtml).toContain("Autumn Jazz Concert");
		expect(baseHtml).not.toContain("event-search-form__clear");

		// Filter by text ("salsa")
		const byText = await container.renderToString(EventList, {
			props: { entries, view: pastView, now },
			request: new Request("https://example.org/past-events/?events-q%5Bold-events%5D=salsa"),
		});
		expect(byText).toContain("Fall Salsa Dance Series");
		expect(byText).not.toContain("Spring Yoga Workshop");
		expect(byText).not.toContain("Autumn Jazz Concert");
		expect(byText).toContain("event-search-form__clear");

		// Filter by month (10 = October) across years
		const byMonth = await container.renderToString(EventList, {
			props: { entries, view: pastView, now },
			request: new Request("https://example.org/past-events/?events-month-num%5Bold-events%5D=10"),
		});
		expect(byMonth).toContain("Fall Salsa Dance Series");
		expect(byMonth).toContain("Autumn Jazz Concert");
		expect(byMonth).not.toContain("Spring Yoga Workshop");

		// Filter by month + year (2025-10)
		const byMonthYear = await container.renderToString(EventList, {
			props: { entries, view: pastView, now },
			request: new Request(
				"https://example.org/past-events/?events-month-num%5Bold-events%5D=10&events-year%5Bold-events%5D=2025",
			),
		});
		expect(byMonthYear).toContain("Autumn Jazz Concert");
		expect(byMonthYear).not.toContain("Fall Salsa Dance Series");
		expect(byMonthYear).not.toContain("Spring Yoga Workshop");
		// Year select still offers 2026 so visitor can switch years without clearing first
		expect(byMonthYear).toContain(">2026</option>");
	});

	it("omits the search form when view.searchBar is absent", async () => {
		const plainView = parseEventView({
			version: 1,
			viewSlug: "upcoming",
			mode: "past",
			order: "desc",
			layout: "list",
			start: "start_current_month",
		})!;
		const container = await AstroContainer.create();
		const html = await container.renderToString(EventList, {
			props: { entries, view: plainView, now },
			request: new Request("https://example.org/upcoming/"),
		});
		expect(html).not.toContain("event-search-form");
	});
});
