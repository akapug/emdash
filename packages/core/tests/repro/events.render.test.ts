import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EventArticle from "../../../../templates/blog-cloudflare/src/components/EventArticle.astro";
import EventEmbed from "../../../../templates/blog-cloudflare/src/components/EventEmbed.astro";
import EventList from "../../../../templates/blog-cloudflare/src/components/EventList.astro";
import PageArticle from "../../../../templates/blog-cloudflare/src/components/PageArticle.astro";
import WpShellEmbed from "../../../../templates/blog-cloudflare/src/components/WpShellEmbed.astro";
import WpShellPortableText from "../../../../templates/blog-cloudflare/src/components/WpShellPortableText.astro";
import WpShell from "../../../../templates/blog-cloudflare/src/layouts/WpShell.astro";
import EventDetail from "../../../../templates/blog-cloudflare/src/pages/events/[slug].astro";
import EventsIndex from "../../../../templates/blog-cloudflare/src/pages/events/index.astro";
import ShellEventDetail from "../../../../templates/blog-cloudflare/src/pages/wp-shell/events/[slug].astro";
import ShellEventsIndex from "../../../../templates/blog-cloudflare/src/pages/wp-shell/events/index.astro";
import {
	eventSummary,
	parseEventView,
	selectEventView,
} from "../../../../templates/blog-cloudflare/src/utils/events.js";

const reads = vi.hoisted(() => ({
	shell: null as unknown,
	timezone: undefined as string | undefined,
	collection: vi.fn(),
	entry: vi.fn(),
	schema: vi.fn(),
}));
async function emdashReads() {
	return {
		getEditMeta: () => undefined,
		getCollectionByUrlPattern: reads.schema,
		getEmDashCollection: reads.collection,
		getEmDashEntry: reads.entry,
		decodeSlug: (s: string) => (s ? decodeURIComponent(s) : null),
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Example", wpShell: reads.shell, timezone: reads.timezone },
			cacheHint: { tags: ["settings"] },
		}),
		getMenuWithCacheHint: async () => ({ data: null, cacheHint: {} }),
	};
}
vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);
vi.mock("../../../../templates/blog-cloudflare/src/layouts/Base.astro", async () => ({
	default: (await import("./StubBase.astro")).default,
}));

const now = new Date("2026-11-20T00:30:00Z");
function entry(slug: string, data: Record<string, unknown> = {}) {
	return {
		id: slug,
		data: { id: `ID-${slug}`, status: "published", title: slug, start_date: "2026-11-21", ...data },
		edit: { title: {}, content: {} },
	};
}
const view = {
	version: 1,
	viewSlug: "example",
	mode: "upcoming",
	order: "asc",
	layout: "grid",
	start: "today",
	limit: 2,
};
const shell = {
	version: 1,
	id: "0123456789abcdef01234567",
	source: { url: "https://example.org/", capturedAt: "2026-09-26T00:00:00Z" },
	html: { lang: "en", class: "" },
	body: { class: "page" },
	styles: [],
	menus: [],
	parts: [
		{ html: '<main id="source-shell">' },
		{ slot: "title", tag: "h1" },
		{ slot: "content", tag: "div", class: "entry-content" },
		{ html: "</main>" },
	],
};
async function render(
	component: Parameters<Awaited<ReturnType<typeof AstroContainer.create>>["renderToString"]>[0],
	props = {},
	url = "https://example.org/events/",
	params = {},
) {
	const c = await AstroContainer.create();
	return c.renderToString(component, { props, params, request: new Request(url) });
}
beforeEach(() => {
	vi.useRealTimers();
	reads.shell = null;
	reads.timezone = undefined;
	reads.schema
		.mockReset()
		.mockResolvedValue({ slug: "custom_meetups", urlPattern: "/events/{slug}" });
	reads.collection
		.mockReset()
		.mockResolvedValue({ entries: [], cacheHint: { tags: ["events"] }, hasMore: false });
	reads.entry.mockReset().mockResolvedValue({ entry: entry("open-day"), cacheHint: {} });
});

describe("source event dates and saved view validation", () => {
	it("keeps source dates/clocks, bool false and stored zero, and cancellation separate from publication", () => {
		for (const all_day of [false, 0]) {
			const e = eventSummary(
				entry("meeting", {
					start_time: "19:30",
					timezone: "America/Los_Angeles",
					all_day,
					event_status: "cancelled",
					cancelled_reason: "Weather",
				}),
				now,
			)!;
			expect(e.date).toBe("2026-11-21");
			expect(e.startTime).toBe("19:30");
			expect(e.allDay).toBe(false);
			expect(e.cancelled).toBe(true);
		}
		expect(eventSummary(entry("bad", { start_date: "2026-02-30" }), now)).toBeNull();
		expect(eventSummary(entry("bad", { all_day: "false" }), now)?.allDay).toBeUndefined();
	});
	it("compares against the event's day at the source timezone boundary", () => {
		expect(
			eventSummary(
				entry("still-today", { start_date: "2026-11-19", timezone: "America/Los_Angeles" }),
				now,
			)?.period,
		).toBe("upcoming");
		expect(
			eventSummary(entry("yesterday", { start_date: "2026-11-19", timezone: "Asia/Tokyo" }), now)
				?.period,
		).toBe("past");
	});
	it("chooses upcoming preview dates and never calls an exhausted preview a finished series", () => {
		expect(
			eventSummary(
				entry("series", { start_date: "2025-01-01", occurrences: '["2026-11-19","2026-11-25"]' }),
				now,
			)?.date,
		).toBe("2026-11-25");
		expect(eventSummary(entry("series", { occurrences: '["2026-11-19"]' }), now)?.period).toBe(
			"preview",
		);
		expect(eventSummary(entry("bad", { occurrences: "2026-11-21,2026-11-22" }), now)).toBeNull();
	});
	it("fails closed on unread, unknown or malformed settings", () => {
		for (const options of [
			{ viewSlug: "only" },
			{ ...view, version: 2 },
			{ ...view, extra: true },
			{ ...view, limit: 0 },
			{ ...view, navigation: true },
			{ ...view, filters: { category: "Arts" } },
		])
			expect(parseEventView(options)).toBeNull();
		expect(parseEventView(view)).not.toBeNull();
	});
	it("applies exact name filters before order/limit and preserves the past view's current-month upper anchor", () => {
		const events = [
			entry("other", { category: "Other" }),
			entry("late", { start_date: "2026-11-25", category: "Arts" }),
			entry("early", { category: "Arts" }),
		].map((e) => eventSummary(e, now)!);
		expect(
			selectEventView(
				events,
				parseEventView({ ...view, limit: 1, filters: { category: ["Arts"] } })!,
				now,
			).map((e) => e.entry.id),
		).toEqual(["early"]);
		const past = [
			entry("old", { start_date: "2026-10-15" }),
			entry("recent", { start_date: "2026-11-10" }),
		].map((e) => eventSummary(e, now)!);
		expect(
			selectEventView(
				past,
				parseEventView({ ...view, mode: "past", start: "start_current_month" })!,
				now,
			).map((e) => e.entry.id),
		).toEqual(["old"]);
	});
});

describe("event rendering in the actual Astro template", () => {
	it("renders nonempty date, clock, location, cover, cancellation and Portable Text body safely", async () => {
		const e = entry("Open <day>", {
			start_time: "19:30",
			end_time: "20:30",
			timezone: "Europe/London",
			location: "Hall <west>",
			all_day: 0,
			event_status: "cancelled",
			cancelled_reason: "Weather",
			featured_image: { src: "/cover.jpg", alt: "Cover" },
			more_info: "javascript:alert(1)",
			content: [
				{
					_type: "block",
					_key: "b",
					children: [{ _type: "span", _key: "s", text: "Bring a notebook", marks: [] }],
					markDefs: [],
					style: "normal",
				},
			],
		});
		const html = await render(EventArticle, { entry: e, now });
		for (const text of [
			"2026-11-21",
			"19:30",
			"20:30",
			"Europe/London",
			"Hall &lt;west&gt;",
			"/cover.jpg",
			"Bring a notebook",
			"Cancelled",
			"Weather",
		])
			expect(html).toContain(text);
		expect(html).not.toContain("All day");
		expect(html).not.toContain('href="javascript:');
	});
	it("index groups upcoming before past and labels recurrence preview uncertainty", async () => {
		const entries = [
			entry("old", { start_date: "2026-01-01" }),
			entry("future"),
			entry("series", { occurrences: '["2026-01-01"]' }),
		];
		const html = await render(EventList, { entries, now });
		expect(html.indexOf("Upcoming events")).toBeLessThan(html.indexOf("Past events"));
		expect(html).toContain("Recurrence preview");
		expect(html).toContain("/events/future/");
	});
	it("an unread saved view is visible and never reads or renders an unfiltered listing", async () => {
		const html = await render(EventEmbed, { node: { events: { viewSlug: "unread" } } });
		expect(html).toContain("Saved event view unavailable");
		expect(html).toContain('href="/events/"');
		expect(reads.collection).not.toHaveBeenCalled();
	});
	it("supported embedded views paginate beyond one source page before filtering and limiting", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		reads.collection
			.mockResolvedValueOnce({
				entries: Array.from({ length: 100 }, (_, i) =>
					entry(`old-${i}`, { start_date: "2020-01-01" }),
				),
				nextCursor: "page2",
				hasMore: true,
				cacheHint: {},
			})
			.mockResolvedValueOnce({
				entries: [
					entry("late", { start_date: "2026-12-01", category: "Arts" }),
					entry("soon", { category: "Arts" }),
					entry("ignored", { category: "Other" }),
				],
				hasMore: false,
				cacheHint: {},
			});
		const html = await render(EventEmbed, {
			node: { events: { ...view, limit: 1, filters: { category: ["Arts"] } } },
		});
		expect(html).toContain("/events/soon/");
		expect(html).not.toContain("/events/late/");
		expect(reads.collection).toHaveBeenCalledTimes(2);
		expect(reads.collection.mock.calls[1]?.[1]).toMatchObject({
			cursor: "page2",
			status: "published",
		});
	});
	it("uses the imported collection's identity for regular index and detail", async () => {
		const html = await render(EventsIndex);
		expect(html).toContain("Events");
		expect(reads.schema).toHaveBeenCalledWith("/events/{slug}");
		expect(reads.collection.mock.calls[0]?.[0]).toBe("custom_meetups");
		expect(
			await render(EventDetail, {}, "https://example.org/events/open-day/", { slug: "open-day" }),
		).toContain("open-day");
		expect(reads.entry).toHaveBeenCalledWith("custom_meetups", "open-day", expect.anything());
	});
	it("draws index/detail through the WordPress shell when rewritten, but refuses direct internal URLs", async () => {
		reads.shell = shell;
		expect(await render(ShellEventsIndex)).toContain('id="source-shell"');
		expect(
			await render(ShellEventDetail, {}, "https://example.org/events/open-day/", {
				slug: "open-day",
			}),
		).toContain("open-day");
		const c = await AstroContainer.create();
		const response = await c.renderToResponse(ShellEventsIndex, {
			request: new Request("https://example.org/wp-shell/events/"),
		});
		expect(response.status).toBe(404);
	});
	it("renders the full detail through both public fallback and shell routes, keeping source dates and query", async () => {
		const detailed = entry("open-day", {
			start_date: "2026-11-21",
			start_time: "18:45",
			timezone: "America/Los_Angeles",
			location: "Main Hall",
			featured_image: { src: "/cover.jpg", alt: "Gathering" },
			content: [
				{
					_type: "block",
					_key: "body",
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: "s", text: "Bring your sketchbook", marks: [] }],
				},
				{
					_type: "embed",
					_key: "month",
					provider: "embark-events",
					url: "/events/",
					events: { ...view, layout: "tile", navigation: true },
				},
			],
		});
		reads.entry.mockResolvedValue({ entry: detailed, cacheHint: {} });
		for (const route of [EventDetail, ShellEventDetail]) {
			reads.shell = route === ShellEventDetail ? shell : null;
			const html = await render(route, {}, "https://example.org/events/open-day/?from=calendar", {
				slug: "open-day",
			});
			for (const text of [
				"2026-11-21",
				"18:45",
				"America/Los_Angeles",
				"Main Hall",
				"/cover.jpg",
				"Bring your sketchbook",
			])
				expect(html).toContain(text);
			if (route === ShellEventDetail) {
				expect(html).toContain('id="source-shell"');
				expect(html).toContain('href="/events/open-day/?from=calendar&amp;events-month');
			}
		}
	});
	it("never silently truncates a supported view with no limit, including a late-page recurrence", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		reads.collection
			.mockResolvedValueOnce({
				entries: Array.from({ length: 100 }, (_, i) => entry(`future-${i}`)),
				nextCursor: "later",
				hasMore: true,
				cacheHint: {},
			})
			.mockResolvedValueOnce({
				entries: Array.from({ length: 30 }, (_, i) => entry(`later-${i}`)).concat([
					entry("series-tail", { start_date: "2020-01-01", occurrences: '["2026-11-22"]' }),
				]),
				hasMore: false,
				cacheHint: {},
			});
		const unlimited = { ...view, limit: undefined };
		const html = await render(EventEmbed, { node: { events: unlimited } });
		expect(html.match(/href="\/events\//g)).toHaveLength(131);
		expect(html).toContain("/events/series-tail/");
	});
	it("does not render unsafe or malformed cover URLs", async () => {
		for (const featured_image of [
			{ src: "javascript:alert(1)" },
			{ src: "data:text/html,bad" },
			{ src: "//other.example/cover" },
			true,
		]) {
			const html = await render(EventArticle, { entry: entry("safe", { featured_image }), now });
			expect(html).not.toMatch(/<img\b/);
		}
	});
	it("refuses direct internal detail requests before reading content, and returns a real public 404 for missing content", async () => {
		const c = await AstroContainer.create();
		const internal = await c.renderToResponse(ShellEventDetail, {
			params: { slug: "open-day" },
			request: new Request("https://example.org/wp-shell/events/open-day/"),
		});
		expect(internal.status).toBe(404);
		expect(reads.entry).not.toHaveBeenCalled();
		reads.entry.mockResolvedValue({ entry: null, cacheHint: {} });
		const missing = await c.renderToResponse(EventDetail, {
			params: { slug: "missing" },
			request: new Request("https://example.org/events/missing/"),
		});
		expect(missing.status).toBe(404);
	});
	it("ordinary page and shell content never discovers or reads an event collection", async () => {
		const content = [
			{
				_type: "block",
				_key: "ordinary",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", _key: "s", text: "Ordinary content", marks: [] }],
			},
		];
		expect(await render(PageArticle, { title: "Page", content, edit: {} })).toContain(
			"Ordinary content",
		);
		expect(
			await render(WpShell, {
				shell,
				kind: "post",
				path: "/posts/ordinary",
				title: "Ordinary post",
				entry: { title: "Ordinary post", body: content, edit: {} },
				comments: false,
			}),
		).toContain("Ordinary content");
		expect(reads.schema).not.toHaveBeenCalled();
		expect(reads.collection).not.toHaveBeenCalled();
	});
	it("draws the source's bounded fifteen-year past view, not just the current month", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		reads.collection.mockResolvedValue({
			entries: [
				entry("last-month", { start_date: "2026-10-20" }),
				entry("last-year", { start_date: "2025-06-10" }),
				entry("too-old", { start_date: "2010-10-10" }),
				entry("after-anchor", { start_date: "2026-11-10" }),
				entry("future", { start_date: "2027-01-01" }),
			],
			hasMore: false,
			cacheHint: {},
		});
		const html = await render(EventEmbed, {
			node: { events: { ...view, mode: "past", start: "start_current_month", limit: undefined } },
		});
		for (const slug of ["last-month", "last-year"]) expect(html).toContain(`/events/${slug}/`);
		for (const slug of ["too-old", "after-anchor", "future"])
			expect(html).not.toContain(`/events/${slug}/`);
	});
	it("renders the imported time note as text even for an all-day event", async () => {
		const html = await render(EventArticle, {
			entry: entry("notes", {
				all_day: 1,
				time_note: 'Doors at dusk <script>alert("no")</script>',
			}),
			now,
		});
		expect(html).toContain("All day");
		expect(html).toContain("Doors at dusk &lt;script&gt;");
		expect(html).not.toContain("<script>alert");
	});
	it("uses the site's source day when an event omits its zone, without fabricating a displayed event zone", async () => {
		reads.timezone = "America/Los_Angeles";
		const boundary = new Date("2026-12-01T00:30:00Z");
		const series = entry("local-preview", {
			start_date: "2020-01-01",
			start_time: "18:00",
			occurrences: '["2026-11-30","2026-12-02"]',
		});
		const article = await render(EventArticle, { entry: series, now: boundary });
		expect(article).toContain('datetime="2026-11-30"');
		expect(article).not.toContain("America/Los_Angeles");
		const listing = await render(EventList, {
			entries: [entry("local-today", { start_date: "2026-11-30" })],
			now: boundary,
		});
		expect(listing).toContain("/events/local-today/");
		expect(listing).toContain("Past events");
		expect(listing.indexOf("/events/local-today/")).toBeLessThan(listing.indexOf("Past events"));
	});
	it("uses the first day of the overflowed lower month and strict start/end cutoffs for past views", () => {
		const clockNow = new Date("2026-11-20T12:00:00Z");
		const entries = [
			entry("first-lower-month", { start_date: "2011-11-01" }),
			entry("before-lower-month", { start_date: "2011-10-31" }),
			entry("ended-today", { start_date: "2026-11-20", start_time: "09:00", end_time: "11:59:59" }),
			entry("running-today", { start_date: "2026-11-20", start_time: "09:00", end_time: "13:00" }),
			entry("ends-at-cutoff", { start_date: "2026-11-20", start_time: "09:00", end_time: "12:00" }),
			entry("unknown-clock", { start_date: "2026-11-20" }),
		].map((item) => eventSummary(item as any, clockNow)!);
		expect(
			selectEventView(entries, { ...view, mode: "past", limit: undefined }, clockNow).map(
				(item) => item.entry.id,
			),
		).toEqual(["first-lower-month", "ended-today"]);
		const upper = [
			entry("ends-before-final-second", {
				start_date: "2026-11-01",
				start_time: "23:59:57",
				end_time: "23:59:58",
			}),
			entry("ends-at-final-second", {
				start_date: "2026-11-01",
				start_time: "23:59:57",
				end_time: "23:59:59",
			}),
			entry("spans-anchor", {
				start_date: "2026-10-31",
				end_date: "2026-11-02",
				start_time: "12:00",
				end_time: "12:00",
			}),
		].map((item) => eventSummary(item as any, clockNow)!);
		expect(
			selectEventView(
				upper,
				{ ...view, mode: "past", start: "start_current_month", limit: undefined },
				clockNow,
			).map((item) => item.entry.id),
		).toEqual(["ends-before-final-second"]);
		const leapNow = new Date("2028-02-29T12:00:00Z");
		const leap = [
			entry("overflow-month", { start_date: "2013-03-01" }),
			entry("before-overflow-month", { start_date: "2013-02-28" }),
		].map((item) => eventSummary(item as any, leapNow)!);
		expect(
			selectEventView(leap, { ...view, mode: "past", limit: undefined }, leapNow).map(
				(item) => item.entry.id,
			),
		).toEqual(["overflow-month"]);
	});
	it("puts an already-ended event from today under past, while a running event stays upcoming", async () => {
		const clockNow = new Date("2026-11-20T12:00:00Z");
		const html = await render(EventList, {
			now: clockNow,
			entries: [
				entry("ended-today", {
					start_date: "2026-11-20",
					start_time: "09:00",
					end_time: "11:59:59",
				}),
				entry("running-today", {
					start_date: "2026-11-20",
					start_time: "09:00",
					end_time: "13:00",
				}),
			],
		});
		expect(html).toContain("/events/ended-today/");
		expect(html).toContain("/events/running-today/");
		expect(html).toContain("Past events");
		expect(html.indexOf("/events/ended-today/")).toBeGreaterThan(html.indexOf("Past events"));
		expect(html.indexOf("/events/running-today/")).toBeLessThan(html.indexOf("Past events"));
	});
	it("preserves rich shell skeleton, link and note marks while dispatching an event embed", async () => {
		const html = await render(WpShellPortableText, {
			value: [
				{
					_type: "elementor-section",
					_key: "el-1000001",
					skeleton: {
						document: {
							tag: "div",
							class: "elementor elementor-42",
							attrs: { "data-elementor-type": "wp-page", "data-elementor-id": "42" },
						},
						wraps: [
							{
								tag: "section",
								class:
									"elementor-section elementor-top-section elementor-element elementor-element-1000001",
							},
						],
						widgets: {
							"1000003": {
								wraps: [
									{
										tag: "div",
										class: "elementor-element elementor-widget elementor-widget-text-editor",
									},
									{ tag: "div", class: "elementor-widget-container" },
								],
							},
						},
					},
				},
				{
					_type: "block",
					_key: "el-1000003",
					style: "normal",
					markDefs: [
						{ _type: "wpShellNote", _key: "hint", title: "Source note", class: "source-note" },
						{
							_type: "link",
							_key: "link",
							href: "/contact/",
							skeletonClass: "source-link",
							skeletonTitle: "Source link",
						},
					],
					children: [
						{ _type: "span", _key: "note", text: "Event source text", marks: ["hint"] },
						{ _type: "span", _key: "link-text", text: "Contact", marks: ["link"] },
					],
				},
				{ _type: "embed", _key: "extra", provider: "embark-events", events: { version: 1 } },
			],
		});
		expect(html).toContain('class="elementor elementor-42"');
		expect(html).toContain('class="source-note"');
		expect(html).toContain('title="Source note"');
		expect(html).toContain('class="source-link"');
		expect(html).toContain('title="Source link"');
		expect(html).toContain("Saved event view unavailable");
	});
	it("intercepts event embeds in both regular and shell Portable Text", async () => {
		const node = {
			_type: "embed",
			_key: "saved",
			provider: "embark-events",
			url: "/events/",
			events: { viewSlug: "unread" },
		};
		for (const component of [WpShellEmbed])
			expect(await render(component, { node })).toContain("Saved event view unavailable");
		expect(await render(PageArticle, { title: "Page", content: [node], edit: {} })).toContain(
			"Saved event view unavailable",
		);
	});
});
