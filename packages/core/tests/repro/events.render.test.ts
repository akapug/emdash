import { readFileSync } from "node:fs";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { serializeProps } from "astro/runtime/server/serialize.js";
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
import {
	getPageCacheState as readPageCacheState,
	runWithPageCacheState,
} from "../../src/page-cache/state.js";

const reads = vi.hoisted(() => ({
	shell: null as unknown,
	timezone: undefined as string | undefined,
	postsPerPage: 10,
	collection: vi.fn(),
	entry: vi.fn(),
	schema: vi.fn(),
	editMeta: vi.fn(),
}));
async function emdashReads() {
	const { getEditMeta } =
		await vi.importActual<typeof import("../../src/query.js")>("../../src/query.js");
	const {
		capPageCacheUntil,
		getPageCacheState,
		optInPageCache,
		optOutPageCache,
		PAGE_CACHE_MIN_TTL_SECONDS,
		PAGE_CACHE_MAX_TTL_SECONDS,
	} = await import("../../src/page-cache/state.js");
	reads.editMeta.mockImplementation(getEditMeta);
	return {
		capPageCacheUntil,
		getPageCacheState,
		optInPageCache,
		optOutPageCache,
		PAGE_CACHE_MIN_TTL_SECONDS,
		PAGE_CACHE_MAX_TTL_SECONDS,
		getEditMeta: reads.editMeta,
		getCollectionByUrlPattern: reads.schema,
		getEmDashCollection: reads.collection,
		getEmDashEntry: reads.entry,
		decodeSlug: (s: string) => (s ? decodeURIComponent(s) : null),
		getSiteSettingsWithCacheHint: async () => ({
			data: {
				title: "Example",
				wpShell: reads.shell,
				timezone: reads.timezone,
				postsPerPage: reads.postsPerPage,
			},
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
		data: {
			id: `ID-${slug}`,
			status: "published",
			title: slug,
			locale: "en-US",
			start_date: "2026-11-21",
			...data,
		},
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
	reads.postsPerPage = 10;
	reads.editMeta.mockClear();
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

function eventPageLink(html: string, rel: "prev" | "next") {
	const tag = html.match(new RegExp(`<a[^>]*rel="${rel}"[^>]*>`))?.[0];
	expect(tag, `${rel} event page link`).toBeDefined();
	return new URL(tag!.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), "https://example.org");
}

describe("bounded event list rows and pages", () => {
	it("bounds desktop list thumbnails beside content and stacks the same row on mobile", async () => {
		const html = await render(EventList, {
			entries: [
				entry("pictured", {
					featured_image: { src: "/cover.jpg", alt: "Cover" },
					location: "Hall",
				}),
			],
			now,
			view: parseEventView({ ...view, layout: "list" }),
		});
		expect(html).toContain("event-card__body");
		expect(html).toContain("/cover.jpg");
		expect(html).toContain("/events/pictured/");
		expect(html).toContain("Sat, Nov 21, 2026");
		expect(html).toContain("Hall");
		const source = readFileSync(
			new URL(
				"../../../../templates/blog-cloudflare/src/components/EventList.astro",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).toMatch(/\.event-list--list \.event-card\s*\{[^}]*flex-direction:\s*row/);
		expect(source).toMatch(
			/\.event-list--list \.event-card :global\(img\)\s*\{[^}]*width:\s*15rem/,
		);
		expect(source).toContain("aspect-ratio: 4 / 3");
		expect(source).toMatch(
			/@media\s*\(max-width: 767px\)[\s\S]*\.event-list--list \.event-card\s*\{[^}]*flex-direction:\s*column/,
		);
	});
	it("contains index and list views in body-width gutters without narrowing the home grid", async () => {
		const entries = [entry("one")];
		for (const props of [
			{ entries, now },
			{ entries, now, view: parseEventView({ ...view, layout: "list" }) },
		]) {
			expect(await render(EventList, props)).toContain("event-list--contained");
		}
		const grid = await render(EventList, { entries, now, view: parseEventView(view) });
		expect(grid).toContain("event-list--grid");
		expect(grid).not.toContain("event-list--contained");
		const source = readFileSync(
			new URL(
				"../../../../templates/blog-cloudflare/src/components/EventList.astro",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).toContain("--wp--style--global--content-size");
		expect(source).toContain("--max-width");
		expect(source).toMatch(/\.event-list--contained\s*\{[^}]*padding-inline:/);
	});
	it("pages a filtered past list newest-first through real more links without dropping state or entries", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		reads.postsPerPage = 2;
		reads.collection.mockResolvedValue({
			entries: [
				...[2, 5, 1, 4, 3].map((day) =>
					entry(`past-${day}`, { start_date: `2026-11-${10 + day}`, category: "Arts" }),
				),
				entry("excluded", { start_date: "2026-11-19", category: "Other" }),
			],
			hasMore: false,
			cacheHint: {},
		});
		const node = {
			events: {
				...view,
				viewSlug: "past",
				mode: "past",
				order: "desc",
				layout: "list",
				limit: undefined,
				filters: { category: ["Arts"] },
			},
		};
		let url = new URL(
			"https://example.org/past-events/?q=one%20two&events-page%5Bother%5D=3&events-month%5Btile%5D=2026-11",
		);
		const seen: string[] = [];
		for (const [page, expected] of [
			[1, [5, 4]],
			[2, [3, 2]],
			[3, [1]],
		] as const) {
			const html = await render(EventEmbed, { node }, url.href);
			const ids = Array.from(html.matchAll(/href="\/events\/(past-\d)\//g), (m) => m[1]);
			expect(ids).toEqual(expected.map((day) => `past-${day}`));
			seen.push(...ids);
			expect(html).not.toContain("/events/excluded/");
			if (page > 1) {
				const prev = eventPageLink(html, "prev");
				expect(prev.pathname).toBe("/past-events/");
				expect(prev.searchParams.get("events-page[past]")).toBe(
					page === 2 ? null : String(page - 1),
				);
			}
			if (page < 3) {
				url = eventPageLink(html, "next");
				expect(url.pathname).toBe("/past-events/");
				expect(url.searchParams.get("q")).toBe("one two");
				expect(url.searchParams.get("events-page[other]")).toBe("3");
				expect(url.searchParams.get("events-month[tile]")).toBe("2026-11");
				expect(url.searchParams.get("events-page[past]")).toBe(String(page + 1));
			} else expect(html).not.toContain('rel="next"');
		}
		expect(seen).toEqual(["past-5", "past-4", "past-3", "past-2", "past-1"]);
	});
	it("pages index groups independently using the same site page size", async () => {
		reads.postsPerPage = 2;
		const entries = [1, 2, 3].flatMap((day) => [
			entry(`up-${day}`, { start_date: `2026-11-${20 + day}` }),
			entry(`old-${day}`, { start_date: `2026-11-${10 + day}` }),
		]);
		const first = await render(EventList, { entries, now });
		for (const id of ["up-1", "up-2", "old-3", "old-2"]) expect(first).toContain(`/events/${id}/`);
		for (const id of ["up-3", "old-1"]) expect(first).not.toContain(`/events/${id}/`);
		const next = eventPageLink(first, "next");
		expect(next.pathname).toBe("/events/");
		expect(next.searchParams.get("events-page[index-upcoming]")).toBe("2");
		const second = await render(EventList, { entries, now }, next.href);
		for (const id of ["up-3", "old-3", "old-2"]) expect(second).toContain(`/events/${id}/`);
		for (const id of ["up-1", "up-2", "old-1"]) expect(second).not.toContain(`/events/${id}/`);
	});
	it("keeps a missing home cover absent and does not paginate the next-three grid", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		reads.postsPerPage = 1;
		reads.collection.mockResolvedValue({
			entries: [1, 2, 3, 4].map((day) =>
				entry(`home-${day}`, {
					start_date: `2026-11-${20 + day}`,
					featured_image: day < 3 ? { src: `/cover-${day}.jpg`, alt: "Cover" } : undefined,
				}),
			),
			hasMore: false,
			cacheHint: {},
		});
		const html = await render(EventEmbed, { node: { events: { ...view, limit: 3 } } });
		expect(html.match(/<li[^>]*class="event-card"/g)).toHaveLength(3);
		expect(html.match(/<img\b/g)).toHaveLength(2);
		expect(html).toContain("/events/home-3/");
		expect(html).not.toContain("/events/home-4/");
		expect(html).not.toContain("event-card__cover");
		expect(html).not.toContain('rel="next"');
	});
	it("fails visibly on invalid, duplicate and out-of-range page selectors instead of silently resetting", async () => {
		for (const page of [
			"0",
			"-1",
			"1.5",
			"02",
			"not-a-page",
			"99999999999999999999",
			"2&events-page[example]=3",
		]) {
			const html = await render(
				EventList,
				{ entries: [entry("one")], now, view: parseEventView({ ...view, layout: "list" }) },
				`https://example.org/upcoming/?q=keep&events-page[other]=3&events-page[example]=${page}`,
			);
			expect(html).toContain("Event page unavailable");
			expect(html).not.toContain("/events/one/");
			const first = new URL(
				html.match(/href="([^"]+)"[^>]*>View first page/)![1]!.replaceAll("&amp;", "&"),
				"https://example.org",
			);
			expect(first.pathname).toBe("/upcoming/");
			expect(first.searchParams.has("events-page[example]")).toBe(false);
			expect(first.searchParams.get("events-page[other]")).toBe("3");
			expect(first.searchParams.get("q")).toBe("keep");
		}
	});
});

describe("event rendering in the actual Astro template", () => {
	it("uses the native query locale for human dates and clocks in list, home embed and detail", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const localized = entry("rencontre", {
			locale: "fr-FR",
			start_date: "2026-11-20",
			start_time: "19:00",
			end_time: "21:00",
			location: "Salle",
		});
		reads.collection.mockResolvedValue({ entries: [localized], hasMore: false, cacheHint: {} });
		const surfaces = [
			await render(EventList, { entries: [localized], now }),
			await render(EventArticle, { entry: localized, now }),
			await render(EventEmbed, { node: { events: view } }),
		];
		for (const html of surfaces) {
			expect(html).toContain("ven. 20 nov. 2026");
			expect(html).toContain('datetime="2026-11-20"');
			expect(html).toMatch(/19:00\s*–\s*21:00/);
			expect(html).toContain("Salle");
			expect(html).not.toContain("Nov 20");
			expect(html).not.toContain("Recurrence preview");
		}
	});
	it("renders a next-three home grid with a cover before each linked title and no fourth card", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		reads.collection.mockResolvedValue({
			entries: [4, 2, 1, 3].map((day) =>
				entry(`day-${day}`, {
					start_date: `2026-11-${20 + day}`,
					featured_image: { src: `/cover-${day}.jpg`, alt: `Cover ${day}` },
					location: "Main Hall",
				}),
			),
			hasMore: false,
			cacheHint: {},
		});
		const html = await render(EventEmbed, { node: { events: { ...view, limit: 3 } } });
		expect(html).toContain("event-list--grid");
		expect(html.match(/<li[^>]*class="event-card"/g)).toHaveLength(3);
		expect(html.match(/<img\b/g)).toHaveLength(3);
		for (const day of [1, 2, 3]) {
			expect(html).toContain(`/events/day-${day}/`);
			expect(html.indexOf(`/cover-${day}.jpg`)).toBeLessThan(html.indexOf(`/events/day-${day}/`));
		}
		expect(html).toContain("Sat, Nov 21, 2026");
		expect(html).toContain("Main Hall");
		expect(html).not.toContain("/events/day-4/");
		expect(html).not.toContain("Recurrence preview");
	});
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
			"Sat, Nov 21, 2026",
			"7:30",
			"8:30",
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
	it("index groups upcoming before past and keeps uncertainty without internal preview wording", async () => {
		const entries = [
			entry("old", { start_date: "2026-01-01" }),
			entry("future"),
			entry("series", { occurrences: '["2026-01-01"]' }),
		];
		const html = await render(EventList, { entries, now });
		expect(html.indexOf("Upcoming events")).toBeLessThan(html.indexOf("Past events"));
		expect(html).toContain("More dates may be available");
		expect(html).not.toContain("Recurrence preview");
		expect(html).not.toContain("Every ");
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
	it.each([
		{ variant: "Base", index: EventsIndex, detail: EventDetail, shell: null },
		{ variant: "WpShell", index: ShellEventsIndex, detail: ShellEventDetail, shell },
	])(
		"requests epoch caching only for successful public $variant event pages without a query",
		async ({ index, detail, shell: routeShell }) => {
			vi.useFakeTimers();
			vi.setSystemTime(now);
			reads.shell = routeShell;
			const indexUrl = "https://example.org/events/";
			const detailUrl = `${indexUrl}open-day/`;
			const params = { slug: "open-day" };
			const cacheState = (...args: Parameters<typeof render>) =>
				runWithPageCacheState(async () => {
					await render(...args);
					return readPageCacheState();
				});

			expect(await cacheState(index, {}, indexUrl)).toMatchObject({
				optedIn: true,
				ttlSeconds: 300,
			});
			expect(await cacheState(detail, {}, detailUrl, params)).toMatchObject({
				optedIn: true,
				ttlSeconds: 300,
			});
			expect(
				await cacheState(index, {}, `${indexUrl}?events-page[index-upcoming]=2`),
			).toMatchObject({
				optedIn: false,
			});
			expect(await cacheState(detail, {}, `${detailUrl}?q=open`, params)).toMatchObject({
				optedIn: false,
			});
			if (routeShell) {
				const internal = "https://example.org/wp-shell/events/";
				expect(await cacheState(index, {}, internal)).toMatchObject({ optedIn: false });
				expect(await cacheState(detail, {}, `${internal}open-day/`, params)).toMatchObject({
					optedIn: false,
				});
			}

			reads.entry.mockResolvedValue({
				entry: entry("open-day", {
					timezone: "UTC",
					all_day: true,
					occurrences: ["2026-11-21", "2026-11-28"],
				}),
				cacheHint: {},
			});
			vi.setSystemTime(new Date("2026-11-21T23:59:00Z"));
			expect(await cacheState(detail, {}, detailUrl, params)).toMatchObject({
				optedIn: true,
				deadlineMs: Date.parse("2026-11-22T00:00:00Z"),
			});
			vi.setSystemTime(new Date("2026-11-21T23:59:45Z"));
			expect(await cacheState(detail, {}, detailUrl, params)).toMatchObject({ optedOut: true });

			vi.setSystemTime(now);
			reads.collection.mockResolvedValue({
				entries: [],
				error: new Error("unavailable"),
				cacheHint: {},
			});
			reads.entry.mockResolvedValue({ entry: null, cacheHint: {} });
			expect(await cacheState(index, {}, indexUrl)).toMatchObject({ optedIn: false });
			expect(await cacheState(detail, {}, detailUrl, params)).toMatchObject({ optedIn: false });
		},
	);
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
				"Sat, Nov 21, 2026",
				"6:45 PM",
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
				entries: [
					...Array.from({ length: 30 }, (_, i) => entry(`later-${i}`)),
					entry("series-tail", { start_date: "2020-01-01", occurrences: '["2026-11-22"]' }),
				],
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
		expect(html).toContain("Sat, Nov 21, 2026");
		expect(html).not.toContain("All day");
		expect(html).not.toMatch(/\d{1,2}:\d{2}/);
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
		const value = [
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
		];
		const html = await render(WpShellPortableText, { value });
		expect(html).toContain('class="elementor elementor-42"');
		expect(html).toContain('class="source-note"');
		expect(html).toContain('title="Source note"');
		expect(html).toContain('class="source-link"');
		expect(html).toContain('title="Source link"');
		expect(html).toContain("Saved event view unavailable");
		expect(html).not.toContain("<astro-island");

		// The native query interface tags the ORIGINAL PT array non-enumerably.
		const metadata = { collection: "custom_meetups", id: "editable-event", field: "content" };
		Object.defineProperty(value, Symbol.for("__emdash"), { value: metadata });
		const container = await AstroContainer.create();
		// As in portable-text-table.render.test.ts, no React/browser execution is involved.
		container.addServerRenderer({
			name: "@astrojs/react",
			renderer: {
				check: async () => false,
				renderToStaticMarkup: async () => {
					throw new Error("Expected the native client-only editor");
				},
			},
		});
		container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
		const editor = await container.renderToString(WpShellPortableText, { props: { value } });
		expect(reads.editMeta.mock.calls.at(-1)?.[0]).toBe(value);
		const assertEditor = (output: string) => {
			const island = output.match(/<astro-island\b[^>]*>/)?.[0];
			expect(island).toBeDefined();
			expect(island).toContain('component-export="InlinePortableTextEditor"');
			expect(island).toContain('client="only"');
			const encoded = island!.match(/\bprops="([^"]*)"/)?.[1];
			expect(encoded).toBeDefined();
			const props = JSON.parse(encoded!.replaceAll("&quot;", '"'));
			expect(props).toMatchObject(
				JSON.parse(
					serializeProps(
						{
							value,
							collection: metadata.collection,
							entryId: metadata.id,
							field: metadata.field,
						},
						{ displayName: "InlinePortableTextEditor" } as never,
					),
				),
			);
		};
		assertEditor(editor);
		expect(editor).not.toContain('<div class="elementor elementor-42"');
		expect(Object.getOwnPropertyDescriptor(value, Symbol.for("__emdash"))?.value).toBe(metadata);

		// Negative control: force the wrapper's always-skeleton decision without changing source.
		reads.editMeta.mockReturnValueOnce(undefined);
		const alwaysSkeleton = await container.renderToString(WpShellPortableText, {
			props: { value },
		});
		expect(alwaysSkeleton).toContain('class="elementor elementor-42"');
		expect(alwaysSkeleton).not.toContain("<astro-island");
		expect(() => assertEditor(alwaysSkeleton)).toThrow();
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
