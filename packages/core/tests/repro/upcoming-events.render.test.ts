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
		const during = eventSummary(yoga, new Date("2026-11-23T23:00:00Z"), undefined, "America/New_York");
		expect(during?.date).toBe("2026-11-23");
		expect(during?.period).toBe("upcoming");

		// 2026-11-23 20:00 EST (= 2026-11-24T01:00:00Z): yoga ended at 18:45 EST -> advances to Nov 30
		const after = eventSummary(yoga, new Date("2026-11-24T01:00:00Z"), undefined, "America/New_York");
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
});
