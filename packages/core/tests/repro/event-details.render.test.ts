import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import EventArticle from "../../../../templates/blog-cloudflare/src/components/EventArticle.astro";
import EventList from "../../../../templates/blog-cloudflare/src/components/EventList.astro";
import { GET as getEventIcs } from "../../../../templates/blog-cloudflare/src/pages/events/[slug].ics.js";
import {
	buildEventIcs,
	googleCalendarUrl,
} from "../../../../templates/blog-cloudflare/src/utils/event-calendar-export.js";
import {
	eventSummary,
	parseEventView,
} from "../../../../templates/blog-cloudflare/src/utils/events.js";
import {
	EVENT_DETAIL_FIELDS_CAPABILITY,
	IMPORT_CAPABILITIES,
} from "../../src/astro/routes/api/import/wordpress/analyze.js";
import { mappedEmbedsSchema } from "../../src/astro/routes/api/import/wordpress/mapped-embeds.js";
import { mecEventFieldType } from "../../src/astro/routes/api/import/wordpress/mapped-fields.js";

const mocks = vi.hoisted(() => ({
	capPageCacheUntil: vi.fn<(deadlineMs: number) => void>(),
	optOutPageCache: vi.fn<() => void>(),
	entry: null as unknown,
}));

async function emdashReads() {
	return {
		capPageCacheUntil: mocks.capPageCacheUntil,
		optOutPageCache: mocks.optOutPageCache,
		PAGE_CACHE_MIN_TTL_SECONDS: 30,
		PAGE_CACHE_MAX_TTL_SECONDS: 300,
		decodeSlug: (s: string | undefined) => (s ? decodeURIComponent(s) : null),
		getCollectionByUrlPattern: async () => ({ slug: "events" }),
		getEmDashEntry: async () => ({
			entry: mocks.entry,
			isPreview: false,
			cacheHint: { tags: ["events"] },
		}),
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Example Events", timezone: "America/New_York", postsPerPage: 10 },
			cacheHint: { tags: ["settings"] },
		}),
	};
}
vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);

function makeEvent(slug: string, title: string, extra: Record<string, unknown> = {}) {
	return {
		id: slug,
		data: {
			id: `ID-${slug}`,
			status: "published",
			title,
			locale: "en-US",
			start_date: "2026-11-30",
			start_time: "17:30",
			end_time: "18:45",
			location: "Community Hall",
			location_address: "100 Main St. Springfield, NC",
			organizer: "Jane Doe",
			organizer_url: "https://example.org/jane/",
			category: "Workshops",
			content: [
				{
					_type: "block",
					children: [{ _type: "span", text: "Join us for an evening workshop." }],
				},
			],
			...extra,
		},
		edit: { title: {}, content: {} },
	};
}

describe("Item 134: event pages, venue address, website row, calendar exports, and MEC date formats", () => {
	const now = new Date("2026-11-15T12:00:00Z");

	it("advertises emdash.event-detail-fields.v1 and accepts location_address, organizer_url, and dateStyle=mec", () => {
		expect(IMPORT_CAPABILITIES).toContain(EVENT_DETAIL_FIELDS_CAPABILITY);
		expect(mecEventFieldType("location_address")).toBe("string");
		expect(mecEventFieldType("organizer_url")).toBe("string");
		expect(
			mappedEmbedsSchema.safeParse({
				"414": {
					_type: "embed",
					_key: "mec-414",
					provider: "embark-events",
					url: "/events/",
					events: {
						version: 1,
						viewSlug: "home-grid",
						mode: "upcoming",
						order: "asc",
						layout: "grid",
						start: "today",
						limit: 3,
						dateStyle: "mec",
					},
				},
			}).success,
		).toBe(true);
	});

	it("renders description BEFORE labelled detail rows (Date, Time, Location+address, Category, Organizer, Website) and add-to-calendar links", async () => {
		const container = await AstroContainer.create();
		const entry = makeEvent("evening-workshop", "Evening Workshop");
		const html = await container.renderToString(EventArticle, {
			props: { entry, now },
			request: new Request("https://example.org/events/evening-workshop/"),
		});

		// Description appears directly under title, BEFORE the labelled details block.
		const descIdx = html.indexOf("Join us for an evening workshop.");
		const dateIdx = html.indexOf("Date:");
		const locIdx = html.indexOf("Location: Community Hall");
		const addrIdx = html.indexOf("100 Main St. Springfield, NC");
		const websiteIdx = html.indexOf("Website:");
		expect(descIdx).toBeGreaterThan(-1);
		expect(dateIdx).toBeGreaterThan(descIdx);
		expect(locIdx).toBeGreaterThan(dateIdx);
		expect(addrIdx).toBeGreaterThan(locIdx);
		expect(websiteIdx).toBeGreaterThan(locIdx);

		// Labelled detail rows and safe Website link.
		expect(html).toContain("Time:");
		expect(html).toContain("Category: Workshops");
		expect(html).toContain("Organizer: Jane Doe");
		expect(html).toContain('href="https://example.org/jane/"');
		expect(html).toContain("example.org/jane");

		// Add to Google Calendar & iCal / Outlook export links.
		expect(html).toContain("+ Add to Google Calendar");
		expect(html).toContain("https://calendar.google.com/calendar/render?");
		expect(html).toContain("ctz=America%2FNew_York");
		expect(html).toContain("+ iCal / Outlook export");
		expect(html).toContain('href="/events/evening-workshop.ics"');
	});

	it("exports a floating wall-clock time, never UTC, when neither the event nor the site names a zone", () => {
		const noZone = eventSummary(makeEvent("nozone-ev", "No\rZone"), now)!;
		const ics = buildEventIcs(noZone, "https://example.org/events/nozone-ev/");
		expect(ics).toContain("DTSTART:20261130T173000\r\n");
		expect(ics).toContain("DTEND:20261130T184500\r\n");
		expect(ics).not.toContain("TZID=");
		expect(ics).not.toContain("T173000Z");
		// A bare carriage return in the title cannot start a new line of the file.
		expect(ics).toContain("SUMMARY:NoZone\r\n");
		const gcal = googleCalendarUrl(noZone, "https://example.org/events/nozone-ev/");
		expect(gcal).toContain("dates=20261130T173000%2F20261130T184500");
		expect(gcal).not.toContain("ctz=");
		expect(gcal).not.toContain("173000Z");
	});

	it("builds Google Calendar URLs and RFC 5545 .ics payloads for timed, all-day, overnight, and recurring events", async () => {
		const timed = eventSummary(
			makeEvent("timed-ev", "Timed Event", { timezone: "America/New_York" }),
			now,
		)!;
		const gcalTimed = googleCalendarUrl(timed, "https://example.org/events/timed-ev/");
		expect(gcalTimed).toContain("dates=20261130T173000%2F20261130T184500");
		expect(gcalTimed).toContain("ctz=America%2FNew_York");
		expect(gcalTimed).toContain("Community+Hall%2C+100+Main+St.+Springfield%2C+NC");

		const allDay = eventSummary(
			makeEvent("allday-ev", "All Day Event", {
				all_day: true,
				start_date: "2026-12-05",
				end_date: "2026-12-06",
				start_time: undefined,
				end_time: undefined,
			}),
			now,
		)!;
		expect(googleCalendarUrl(allDay)).toContain("dates=20261205%2F20261207");
		const icsAllDay = buildEventIcs(allDay, "https://example.org/events/allday-ev/");
		expect(icsAllDay).toContain("DTSTART;VALUE=DATE:20261205");
		expect(icsAllDay).toContain("DTEND;VALUE=DATE:20261207");

		const overnight = eventSummary(
			makeEvent("overnight-ev", "Late Night", {
				start_date: "2026-12-10",
				start_time: "22:00",
				end_time: "01:30",
				timezone: "America/New_York",
			}),
			now,
		)!;
		expect(googleCalendarUrl(overnight)).toContain("dates=20261210T220000%2F20261211T013000");
		const icsOvernight = buildEventIcs(overnight, "https://example.org/events/overnight-ev/");
		expect(icsOvernight).toContain("DTSTART;TZID=America/New_York:20261210T220000");
		expect(icsOvernight).toContain("DTEND;TZID=America/New_York:20261211T013000");

		// Recurring event uses next upcoming occurrence AND endpoint serves text/calendar.
		const recurringEntry = makeEvent("weekly-yoga", "Weekly Yoga", {
			start_date: "2026-01-05",
			occurrences: ["2026-11-09", "2026-11-23", "2026-11-30"],
		});
		const recurring = eventSummary(recurringEntry, now, undefined, "America/New_York")!;
		expect(recurring.date).toBe("2026-11-23");
		expect(buildEventIcs(recurring)).toContain("DTSTART;TZID=America/New_York:20261123T173000");

		mocks.entry = recurringEntry;
		const res = await getEventIcs({
			params: { slug: "weekly-yoga" },
			url: new URL("https://example.org/events/weekly-yoga.ics"),
			currentLocale: "en",
		} as never);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
		const icsBody = await res.text();
		expect(icsBody).toContain("BEGIN:VCALENDAR");
		expect(icsBody).toContain("SUMMARY:Weekly Yoga");
		expect(icsBody).toContain("LOCATION:Community Hall\\, 100 Main St. Springfield\\, NC");
	});

	it("renders MEC two-line date format on list cards, omits invented heading + prints full date above title on MEC home grid, and preserves default format when dateStyle is absent", async () => {
		const container = await AstroContainer.create();
		const ev = makeEvent("monday-yoga", "Yoga on Mondays");

		// 1. MEC list view: two-line "30 Nov" + "5:30 pm - 6:45 pm" + venue name & address.
		const mecListView = parseEventView({
			version: 1,
			viewSlug: "upcoming-mec",
			mode: "upcoming",
			order: "asc",
			layout: "list",
			start: "today",
			dateStyle: "mec",
		})!;
		const listHtml = await container.renderToString(EventList, {
			props: { entries: [ev], view: mecListView, now },
			request: new Request("https://example.org/upcoming/"),
		});
		expect(listHtml).toContain("30 Nov");
		expect(listHtml).toContain("5:30 pm - 6:45 pm");
		expect(listHtml).toContain("Community Hall");
		expect(listHtml).toContain("100 Main St. Springfield, NC");

		// 2. MEC home grid view: NO invented "Upcoming events" heading, full date "30 November 2026" ABOVE title, venue address, View Detail.
		const mecHomeView = parseEventView({
			version: 1,
			viewSlug: "home-next",
			mode: "upcoming",
			order: "asc",
			layout: "grid",
			start: "today",
			limit: 3,
			dateStyle: "mec",
		})!;
		const homeHtml = await container.renderToString(EventList, {
			props: { entries: [ev], view: mecHomeView, now },
			request: new Request("https://example.org/"),
		});
		expect(homeHtml).not.toContain("Upcoming events");
		const fullDateIdx = homeHtml.indexOf("30 November 2026");
		const titleIdx = homeHtml.indexOf("Yoga on Mondays");
		expect(fullDateIdx).toBeGreaterThan(-1);
		expect(titleIdx).toBeGreaterThan(fullDateIdx);
		expect(homeHtml).toContain("100 Main St. Springfield, NC");
		expect(homeHtml).toContain("View Detail");

		// 3. Default (non-MEC) view preserves original single-line date format and heading.
		const defaultListView = parseEventView({
			version: 1,
			viewSlug: "default-list",
			mode: "upcoming",
			order: "asc",
			layout: "list",
			start: "today",
		})!;
		const defaultHtml = await container.renderToString(EventList, {
			props: { entries: [ev], view: defaultListView, now },
			request: new Request("https://example.org/events/"),
		});
		expect(defaultHtml).toContain("Upcoming events");
		expect(defaultHtml).toContain("Mon, Nov 30, 2026");
	});

	it("item 160 checks (a)+(b): an undated published event renders without a date line or calendar links, returns 404 on .ics, and is excluded from every date-ordered list and calendar view", async () => {
		const container = await AstroContainer.create();
		const undated = makeEvent("undated-gathering", "Undated Community Gathering", {
			start_date: undefined,
			end_date: undefined,
			start_time: undefined,
			end_time: undefined,
		});
		const upcoming = makeEvent("upcoming-workshop", "Upcoming Workshop", {
			start_date: "2026-11-30",
		});
		const past = makeEvent("past-workshop", "Past Workshop", {
			start_date: "2026-10-15",
		});

		// (a) Single event page renders title + body + unavailable schedule notice, NO Date:, NO Google Calendar link, NO .ics link.
		const articleHtml = await container.renderToString(EventArticle, {
			props: { entry: undated, now },
			request: new Request("https://example.org/events/undated-gathering/"),
		});
		expect(articleHtml).toContain("Undated Community Gathering");
		expect(articleHtml).toContain("Join us for an evening workshop.");
		expect(articleHtml).toContain("Event schedule unavailable");
		expect(articleHtml).not.toContain("Date:");
		expect(articleHtml).not.toContain("calendar.google.com");
		expect(articleHtml).not.toContain(".ics");

		// (a) .ics route returns 404 for an undated event (never invalid ICS or 500).
		mocks.entry = undated;
		const icsResponse = await getEventIcs({
			params: { slug: "undated-gathering" },
			url: new URL("https://example.org/events/undated-gathering.ics"),
			currentLocale: "en-US",
		} as Parameters<typeof getEventIcs>[0]);
		expect(icsResponse.status).toBe(404);

		// (b) Every date-ordered list / calendar view excludes the undated event cleanly without crashing.
		const allEntries = [undated, upcoming, past];

		// Default /events/ index (Upcoming + Past)
		const indexHtml = await container.renderToString(EventList, {
			props: { entries: allEntries, now },
			request: new Request("https://example.org/events/"),
		});
		expect(indexHtml).toContain("Upcoming Workshop");
		expect(indexHtml).toContain("Past Workshop");
		expect(indexHtml).not.toContain("Undated Community Gathering");

		// Upcoming list + monthly calendar grid view
		const upcomingView = parseEventView({
			version: 1,
			viewSlug: "upcoming",
			mode: "upcoming",
			order: "asc",
			layout: "list",
			start: "today",
		})!;
		const upcomingListHtml = await container.renderToString(EventList, {
			props: { entries: allEntries, view: upcomingView, now },
			request: new Request("https://example.org/upcoming/"),
		});
		expect(upcomingListHtml).toContain("Upcoming Workshop");
		expect(upcomingListHtml).not.toContain("Undated Community Gathering");

		const monthlyHtml = await container.renderToString(EventList, {
			props: { entries: allEntries, view: upcomingView, now },
			request: new Request(
				"https://example.org/upcoming/?events-view[upcoming]=monthly&events-month[upcoming]=2026-11",
			),
		});
		expect(monthlyHtml).toContain("Upcoming Workshop");
		expect(monthlyHtml).not.toContain("Undated Community Gathering");

		// Past events list
		const pastView = parseEventView({
			version: 1,
			viewSlug: "past",
			mode: "past",
			order: "desc",
			layout: "list",
			start: "start_current_month",
		})!;
		const pastHtml = await container.renderToString(EventList, {
			props: { entries: allEntries, view: pastView, now },
			request: new Request("https://example.org/past-events/"),
		});
		expect(pastHtml).toContain("Past Workshop");
		expect(pastHtml).not.toContain("Undated Community Gathering");

		// Home "next events" grid cards
		const homeGridView = parseEventView({
			version: 1,
			viewSlug: "home-grid",
			mode: "upcoming",
			order: "asc",
			layout: "grid",
			start: "today",
			limit: 3,
			dateStyle: "mec",
		})!;
		const homeHtml = await container.renderToString(EventList, {
			props: { entries: allEntries, view: homeGridView, now },
			request: new Request("https://example.org/"),
		});
		expect(homeHtml).toContain("Upcoming Workshop");
		expect(homeHtml).not.toContain("Undated Community Gathering");

		// Month bar / tile view
		const tileView = parseEventView({
			version: 1,
			viewSlug: "updates-tile",
			mode: "upcoming",
			order: "asc",
			layout: "tile",
			start: "today",
		})!;
		const tileHtml = await container.renderToString(EventList, {
			props: { entries: allEntries, view: tileView, now },
			request: new Request("https://example.org/updates-2/"),
		});
		expect(tileHtml).toContain("Upcoming Workshop");
		expect(tileHtml).not.toContain("Undated Community Gathering");
	});
});
