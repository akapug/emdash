import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import EventList from "../../../../templates/blog-cloudflare/src/components/EventList.astro";
import {
	eventSummary,
	parseEventView,
} from "../../../../templates/blog-cloudflare/src/utils/events.js";

async function emdashReads() {
	return {
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Dreaming Stone", timezone: "America/New_York", postsPerPage: 10 },
			cacheHint: { tags: ["settings"] },
		}),
	};
}
vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);

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

function makeParagraph(text: string) {
	return [{ _type: "block", children: [{ _type: "span", text }] }];
}

describe("MEC upcoming list skin, timezone today-occurrence rule, and Monthly calendar tab (Item 118)", () => {
	const upcomingView = parseEventView({
		version: 1,
		viewSlug: "upcoming-events",
		mode: "upcoming",
		order: "asc",
		layout: "list",
		start: "today",
	})!;

	const yoga = makeEvent("yoga-with-magi-king", "Yoga with Magi King on Mondays!", "2026-01-05", {
		start_time: "17:30",
		end_time: "18:45",
		occurrences: ["2026-11-23", "2026-11-30", "2026-12-07"],
		content: makeParagraph(
			"THIS CLASS OCCURS EVERY MONDAY! YOU ARE WELCOME TO DROP IN! Start your week off right with a restorative yoga practice led by Magi King in the barn studio. ".repeat(
				4,
			),
		),
	});
	const emigre = makeEvent("emigre-december-12th", "Émigré – December 12th", "2026-12-12", {
		start_time: "19:00",
		end_time: "21:00",
		content: makeParagraph("Join this special holiday show featuring Celtic folk songs."),
	});
	const breathe = makeEvent("breathe-and-renew", "Breathe and Renew", "2026-12-16", {
		start_time: "17:30",
		end_time: "19:00",
		content: makeParagraph("Nourish your spirit by joining this restorative breathwork practice."),
	});
	const salsa = makeEvent("spring-27-salsa", "Spring ’27 Salsa Dance Series", "2027-01-12", {
		start_time: "18:00",
		end_time: "19:00",
		content: makeParagraph("This six-week course expands on the fundamentals of Social Salsa."),
	});

	it("keeps today's recurring occurrence upcoming until end_time in the site's timezone, then advances", () => {
		// 2026-11-23 18:00 EST (= 23:00 UTC): yoga (17:30-18:45 EST) is still in progress
		const during = eventSummary(
			yoga,
			new Date("2026-11-23T23:00:00Z"),
			undefined,
			"America/New_York",
		);
		expect(during?.date).toBe("2026-11-23");
		expect(during?.period).toBe("upcoming");

		// 2026-11-23 20:00 EST (= 2026-11-24T01:00:00Z): yoga ended at 18:45 EST -> advances to Nov 30
		const after = eventSummary(
			yoga,
			new Date("2026-11-24T01:00:00Z"),
			undefined,
			"America/New_York",
		);
		expect(after?.date).toBe("2026-11-30");
		expect(after?.period).toBe("upcoming");

		// Late-evening event ending at 23:00 EST at 22:30 EST (= 2026-11-24T03:30:00Z, already tomorrow UTC)
		const lateEvent = makeEvent("late-jam", "Late Jam", "2026-11-23", {
			start_time: "21:00",
			end_time: "23:00",
			occurrences: ["2026-11-23", "2026-11-30"],
		});
		const lateDuring = eventSummary(
			lateEvent,
			new Date("2026-11-24T03:30:00Z"),
			undefined,
			"America/New_York",
		);
		expect(lateDuring?.date).toBe("2026-11-23");
		expect(lateDuring?.period).toBe("upcoming");
	});

	it("renders month group headings, truncated excerpt, date/time, View Detail link, and List/Monthly tabs", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(EventList, {
			props: {
				entries: [yoga, emigre, breathe, salsa],
				view: upcomingView,
				now: new Date("2026-11-23T20:00:00Z"),
			},
			request: new Request("https://example.org/upcoming/"),
		});
		expect(html).toContain("November 2026");
		expect(html).toContain("December 2026");
		expect(html).toContain("January 2027");
		expect(html).toContain("Yoga with Magi King on Mondays!");
		expect(html).toContain("Nov 23, 2026");
		expect(html).toContain("Breathe and Renew");
		expect(html).toContain("View Detail");
		expect(html).toContain("[…]");
		expect(html).toContain("Monthly");
		expect(html).toContain("events-view%5Bupcoming-events%5D=monthly");
	});

	it("switches to Monthly calendar grid with prev/next links and all occurrences in the month", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(EventList, {
			props: {
				entries: [yoga, emigre, breathe, salsa],
				view: upcomingView,
				now: new Date("2026-11-23T20:00:00Z"),
			},
			request: new Request(
				"https://example.org/upcoming/?events-view%5Bupcoming-events%5D=monthly&events-month%5Bupcoming-events%5D=2026-11",
			),
		});
		expect(html).toContain("event-calendar-grid");
		expect(html).toContain("November 2026");
		expect(html).toContain("Previous month");
		expect(html).toContain("Next month");
		// Both Nov 23 and Nov 30 Monday occurrences appear in the November calendar grid
		expect(html.match(/Yoga with Magi King on Mondays!/g)?.length).toBe(2);
	});

	it("keeps a midnight-crossing weekly event (21:00–01:00 NY) on its start day at 22:30 and 00:30, then advances after 01:00", () => {
		const midnightWeekly = makeEvent("midnight-jam", "Midnight Jam", "2026-11-23", {
			start_time: "21:00",
			end_time: "01:00",
			occurrences: ["2026-11-23", "2026-11-30"],
		});
		// 2026-11-23 22:30 EST (= 2026-11-24T03:30:00Z): still in progress on start day
		const at2230 = eventSummary(
			midnightWeekly,
			new Date("2026-11-24T03:30:00Z"),
			undefined,
			"America/New_York",
		);
		expect(at2230?.date).toBe("2026-11-23");
		expect(at2230?.period).toBe("upcoming");

		// 2026-11-24 00:30 EST (= 2026-11-24T05:30:00Z): still before 01:00 end on next civil day
		const at0030 = eventSummary(
			midnightWeekly,
			new Date("2026-11-24T05:30:00Z"),
			undefined,
			"America/New_York",
		);
		expect(at0030?.date).toBe("2026-11-23");
		expect(at0030?.period).toBe("upcoming");

		// 2026-11-24 01:15 EST (= 2026-11-24T06:15:00Z): ended at 01:00 -> advances to Nov 30
		const at0115 = eventSummary(
			midnightWeekly,
			new Date("2026-11-24T06:15:00Z"),
			undefined,
			"America/New_York",
		);
		expect(at0115?.date).toBe("2026-11-30");
		expect(at0115?.period).toBe("upcoming");
	});

	it("does not read a same-time end written at a different precision as overnight (10:00:00 to 10:00)", () => {
		const mixed = makeEvent("mixed-precision", "Mixed Precision", "2026-11-23", {
			start_time: "10:00:00",
			end_time: "10:00",
			occurrences: ["2026-11-23", "2026-11-30"],
		});
		// 2026-11-23 12:00 EST (= 17:00 UTC): the Monday occurrence ended at 10:00, so it advances to Nov 30
		const noon = eventSummary(
			mixed,
			new Date("2026-11-23T17:00:00Z"),
			undefined,
			"America/New_York",
		);
		expect(noon?.date).toBe("2026-11-30");
	});

	it("expands JSON-string occurrences in Monthly calendar grid using the same decoder as List", async () => {
		const jsonOccYoga = makeEvent("yoga-json-occ", "Yoga JSON Occurrences", "2026-01-05", {
			start_time: "17:30",
			end_time: "18:45",
			occurrences: JSON.stringify(["2026-11-23", "2026-11-30"]),
		});
		const container = await AstroContainer.create();
		const html = await container.renderToString(EventList, {
			props: {
				entries: [jsonOccYoga],
				view: upcomingView,
				now: new Date("2026-11-23T20:00:00Z"),
			},
			request: new Request(
				"https://example.org/upcoming/?events-view%5Bupcoming-events%5D=monthly&events-month%5Bupcoming-events%5D=2026-11",
			),
		});
		expect(html.match(/Yoga JSON Occurrences/g)?.length).toBe(2);
	});

	it("applies searchBar text filtering in Monthly view without List pagination", async () => {
		const searchableView = parseEventView({
			version: 1,
			viewSlug: "upcoming-events",
			mode: "upcoming",
			order: "asc",
			layout: "list",
			start: "today",
			searchBar: { text: true, monthYear: true },
		})!;
		const novSalsa = makeEvent("nov-salsa", "November Salsa Night", "2026-11-25", {
			start_time: "18:00",
			end_time: "20:00",
		});
		const container = await AstroContainer.create();
		const html = await container.renderToString(EventList, {
			props: {
				entries: [yoga, novSalsa],
				view: searchableView,
				now: new Date("2026-11-23T20:00:00Z"),
				pageSize: 1,
			},
			request: new Request(
				"https://example.org/upcoming/?events-view%5Bupcoming-events%5D=monthly&events-month%5Bupcoming-events%5D=2026-11&events-q%5Bupcoming-events%5D=yoga",
			),
		});
		expect(html).toContain("event-calendar-grid");
		expect(html.match(/Yoga with Magi King on Mondays!/g)?.length).toBe(2);
		expect(html).not.toContain("November Salsa Night");
	});

	it("normalizes an invalid events-month param in Monthly view to site-local current month and drops bad value from Monthly link", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(EventList, {
			props: {
				entries: [yoga, emigre],
				view: upcomingView,
				now: new Date("2026-11-24T03:30:00Z"), // 2026-11-23 22:30 America/New_York -> 2026-11
			},
			request: new Request(
				"https://example.org/upcoming/?events-view%5Bupcoming-events%5D=monthly&events-month%5Bupcoming-events%5D=not-a-month",
			),
		});
		expect(html).toContain("event-calendar-grid");
		expect(html).toContain("November 2026");
		expect(html).not.toContain("not-a-month");
	});
});
