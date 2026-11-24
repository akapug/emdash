import type { ContentEntry } from "emdash";

export const EVENT_URL_PATTERN = "/events/{slug}";
const EVENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const EVENT_MONTH_PATTERN = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/;
const EVENT_PAGE_PATTERN = /^[1-9]\d*$/;
const EVENT_VIEW_KEYS = new Set([
	"version",
	"viewSlug",
	"mode",
	"order",
	"layout",
	"start",
	"limit",
	"navigation",
	"filters",
	"searchBar",
]);
const EVENT_SEARCH_BAR_KEYS = new Set(["text", "monthYear"]);
const EVENT_MONTH_NUM_PATTERN = /^(?:0[1-9]|1[0-2])$/;
const EVENT_YEAR_PATTERN = /^(?!0000)\d{4}$/;
export type EventEntry = ContentEntry;
export interface EventSearchBar {
	text?: boolean;
	monthYear?: boolean;
}
export interface EventSearchQuery {
	text: string;
	month: string;
	year: string;
}
export type EventView = {
	version: 1;
	viewSlug: string;
	mode: "upcoming" | "past";
	order: "asc" | "desc";
	layout: "list" | "grid" | "tile";
	start: "today" | "start_current_month";
	limit?: number;
	navigation?: boolean;
	filters?: Partial<Record<"category" | "location" | "organizer", string[]>>;
	searchBar?: EventSearchBar;
};
export interface EventSummary {
	entry: EventEntry;
	date: string;
	endDate?: string;
	startTime?: string;
	endTime?: string;
	timezone?: string;
	referenceTimezone?: string;
	allDay?: boolean;
	cancelled: boolean;
	preview: boolean;
	period: "upcoming" | "past" | "preview";
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function eventString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
export function eventDate(value: unknown): value is string {
	if (typeof value !== "string" || !EVENT_DATE_PATTERN.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function clock(value: unknown): string | undefined {
	return typeof value === "string" && EVENT_TIME_PATTERN.test(value) ? value : undefined;
}
function displayLocale(locale?: string): string | undefined {
	try {
		return locale ? Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0] : undefined;
	} catch {
		return undefined;
	}
}

export function formatEventDate(date: string, locale?: string): string {
	if (!eventDate(date)) return date;
	// These are civil dates, not instants in the event's or the server's zone.
	return new Intl.DateTimeFormat(displayLocale(locale), {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T12:00:00Z`));
}

export function formatEventMonth(month: string, locale?: string): string {
	if (!EVENT_MONTH_PATTERN.test(month)) return month;
	return new Intl.DateTimeFormat(displayLocale(locale), {
		year: "numeric",
		month: "long",
		timeZone: "UTC",
	}).format(new Date(`${month}-01T12:00:00Z`));
}

function civilClock(value: string): Date {
	return new Date(`2000-01-01T${value.length === 5 ? `${value}:00` : value}Z`);
}

export function formatEventTimes(
	event: Pick<EventSummary, "allDay" | "startTime" | "endTime">,
	locale?: string,
): string | undefined {
	if (event.allDay) return undefined;
	const start = clock(event.startTime);
	const end = clock(event.endTime);
	if (!start && !end) return undefined;
	const formatter = new Intl.DateTimeFormat(displayLocale(locale), {
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	});
	if (start && end) {
		// An overnight interval keeps its supplied clocks; no end date is fabricated.
		return civilClock(end) >= civilClock(start)
			? formatter.formatRange(civilClock(start), civilClock(end))
			: `${formatter.format(civilClock(start))} – ${formatter.format(civilClock(end))}`;
	}
	return start
		? formatter.format(civilClock(start))
		: end
			? `Until ${formatter.format(civilClock(end))}`
			: undefined;
}

export function eventToday(now: Date, timezone?: string): string {
	if (timezone) {
		try {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).formatToParts(now);
			return ["year", "month", "day"]
				.map((type) => parts.find((p) => p.type === type)!.value)
				.join("-");
		} catch {
			/* An unknown source zone cannot be used to shift a calendar day. */
		}
	}
	return now.toISOString().slice(0, 10);
}

function eventCurrentClock(now: Date, timezone?: string): string {
	if (timezone) {
		try {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				hourCycle: "h23",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			}).formatToParts(now);
			return ["hour", "minute", "second"]
				.map((type) => parts.find((part) => part.type === type)!.value)
				.join(":");
		} catch {
			/* Use the same UTC reference as eventToday for an unknown source zone. */
		}
	}
	return now.toISOString().slice(11, 19);
}

function beforeEventCutoff(date: string, value: unknown, anchor: string, cutoff: string): boolean {
	if (date !== anchor) return date < anchor;
	const time = clock(value);
	// A missing clock cannot prove that an event on the cutoff day has already ended.
	return time !== undefined && (time.length === 5 ? `${time}:00` : time) < cutoff;
}

function addCivilDays(isoDate: string, days: number): string {
	const date = new Date(`${isoDate}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function decodeEventOccurrences(raw: unknown): string[] | undefined | null {
	if (raw === undefined || raw === null || raw === "") return undefined;
	try {
		const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!Array.isArray(value) || !value.every(eventDate)) return null;
		return [...new Set(value)].toSorted();
	} catch {
		return null;
	}
}

export function eventSummary(
	entry: EventEntry,
	now = new Date(),
	month?: string,
	defaultTimezone?: string,
): EventSummary | null {
	const data = entry.data;
	if ((data.status !== undefined && data.status !== "published") || !eventDate(data.start_date))
		return null;
	const timezone = eventString(data.timezone);
	const referenceTimezone = timezone ?? defaultTimezone;
	const today = eventToday(now, referenceTimezone);
	const decodedDates = decodeEventOccurrences(data.occurrences);
	if (decodedDates === null) return null;
	let dates = decodedDates;
	const preview = dates !== undefined;
	if (month) {
		if (dates) {
			dates = dates.filter((date) => date.startsWith(`${month}-`));
			if (dates.length === 0) return null;
		} else if (!data.start_date.startsWith(`${month}-`)) return null;
	}
	const allDay =
		data.all_day === true || data.all_day === 1
			? true
			: data.all_day === false || data.all_day === 0
				? false
				: undefined;
	const startClock = clock(data.start_time);
	const endClock = clock(data.end_time);
	const crossesMidnight =
		!allDay &&
		startClock !== undefined &&
		endClock !== undefined &&
		civilClock(endClock).getTime() < civilClock(startClock).getTime();
	const occurrenceEndDate = (startDay: string): string =>
		crossesMidnight ? addCivilDays(startDay, 1) : startDay;
	const cutoff = eventCurrentClock(now, referenceTimezone);
	const hasOccurrenceEnded = (startDay: string, endDay: string): boolean => {
		if (endDay < today) return true;
		if (endDay > today) return false;
		if (allDay) return false;
		if (startDay < today) return beforeEventCutoff(endDay, data.end_time, today, cutoff);
		return (
			beforeEventCutoff(startDay, data.start_time, today, cutoff) &&
			beforeEventCutoff(endDay, data.end_time, today, cutoff)
		);
	};
	const upcoming = dates?.find((d) => !hasOccurrenceEnded(d, occurrenceEndDate(d)));
	const date = upcoming ?? dates?.at(-1) ?? data.start_date;
	const endDate =
		eventDate(data.end_date) && data.end_date >= data.start_date ? data.end_date : undefined;
	const effectiveEndDate = endDate ?? occurrenceEndDate(date);
	const past = !preview && hasOccurrenceEnded(date, effectiveEndDate);
	return {
		entry,
		date,
		endDate: preview ? undefined : endDate,
		startTime: allDay ? undefined : startClock,
		endTime: allDay ? undefined : endClock,
		timezone,
		referenceTimezone,
		allDay,
		cancelled: data.event_status === "cancelled" || data.event_status === "canceled",
		preview,
		period: preview ? (upcoming ? "upcoming" : "preview") : past ? "past" : "upcoming",
	};
}

function isEventView(value: unknown): value is EventView {
	if (!object(value)) return false;
	if (
		Object.keys(value).some((key) => !EVENT_VIEW_KEYS.has(key)) ||
		value.version !== 1 ||
		!eventString(value.viewSlug) ||
		(value.mode !== "upcoming" && value.mode !== "past") ||
		(value.order !== "asc" && value.order !== "desc") ||
		(value.layout !== "list" && value.layout !== "grid" && value.layout !== "tile") ||
		(value.start !== "today" && value.start !== "start_current_month") ||
		(value.navigation !== undefined && typeof value.navigation !== "boolean") ||
		(value.navigation === true && value.layout !== "tile") ||
		(value.limit !== undefined &&
			(typeof value.limit !== "number" ||
				!Number.isInteger(value.limit) ||
				value.limit < 1 ||
				value.limit > 100))
	)
		return false;
	if (value.filters !== undefined) {
		if (!object(value.filters)) return false;
		for (const [key, terms] of Object.entries(value.filters)) {
			if (
				!["category", "location", "organizer"].includes(key) ||
				!Array.isArray(terms) ||
				terms.length === 0 ||
				terms.length > 100 ||
				!terms.every((term) => typeof term === "string" && term.trim().length > 0)
			)
				return false;
		}
	}
	if (value.searchBar !== undefined) {
		if (!object(value.searchBar)) return false;
		if (Object.keys(value.searchBar).some((key) => !EVENT_SEARCH_BAR_KEYS.has(key))) return false;
		if (
			(value.searchBar.text !== undefined && typeof value.searchBar.text !== "boolean") ||
			(value.searchBar.monthYear !== undefined && typeof value.searchBar.monthYear !== "boolean")
		)
			return false;
		if (!value.searchBar.text && !value.searchBar.monthYear) return false;
	}
	return true;
}

export function eventSearchQuery(view: EventView, url: URL): EventSearchQuery {
	const rawText = view.searchBar?.text
		? (url.searchParams.get(`events-q[${view.viewSlug}]`) ?? "").trim().slice(0, 200)
		: "";
	const rawMonth = view.searchBar?.monthYear
		? (url.searchParams.get(`events-month-num[${view.viewSlug}]`) ?? "").trim()
		: "";
	const rawYear = view.searchBar?.monthYear
		? (url.searchParams.get(`events-year[${view.viewSlug}]`) ?? "").trim()
		: "";
	return {
		text: rawText,
		month: EVENT_MONTH_NUM_PATTERN.test(rawMonth) ? rawMonth : "",
		year: EVENT_YEAR_PATTERN.test(rawYear) ? rawYear : "",
	};
}

function portableTextPlain(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const block of value) {
		if (!object(block) || !Array.isArray(block.children)) continue;
		for (const child of block.children) {
			if (object(child) && typeof child.text === "string") parts.push(child.text);
		}
	}
	return parts.join(" ");
}

export function filterEventsBySearch(
	events: EventSummary[],
	query: EventSearchQuery,
): EventSummary[] {
	const needle = query.text.toLowerCase();
	if (!needle && !query.month && !query.year) return events;
	return events.filter((event) => {
		if (
			query.year &&
			event.date.slice(0, 4) !== query.year &&
			event.endDate?.slice(0, 4) !== query.year
		) {
			return false;
		}
		if (
			query.month &&
			event.date.slice(5, 7) !== query.month &&
			event.endDate?.slice(5, 7) !== query.month
		) {
			return false;
		}
		if (!needle) return true;
		const data = event.entry.data;
		const haystack = [
			eventString(data.title) ?? event.entry.id,
			...eventTermLabels(event.entry, "location"),
			...eventTermLabels(event.entry, "organizer"),
			...eventTermLabels(event.entry, "category"),
			eventString(data.time_note) ?? "",
			portableTextPlain(data.content),
		]
			.join(" ")
			.toLowerCase();
		return haystack.includes(needle);
	});
}

export function eventAvailableYears(
	events: EventSummary[],
	order: "asc" | "desc" = "desc",
): string[] {
	const years = new Set<string>();
	for (const event of events) {
		if (event.date.length >= 4) years.add(event.date.slice(0, 4));
		if (event.endDate && event.endDate.length >= 4) years.add(event.endDate.slice(0, 4));
	}
	return [...years].toSorted((a, b) => (order === "asc" ? a.localeCompare(b) : b.localeCompare(a)));
}

export function formatEventMonthName(monthNum: string, locale?: string): string {
	if (!EVENT_MONTH_NUM_PATTERN.test(monthNum)) return monthNum;
	return new Intl.DateTimeFormat(displayLocale(locale), {
		month: "long",
		timeZone: "UTC",
	}).format(new Date(`2000-${monthNum}-01T12:00:00Z`));
}

export function parseEventView(value: unknown): EventView | null {
	return isEventView(value) ? value : null;
}

export type EventTermField = "category" | "location" | "organizer";

export function eventTermLabels(entry: EventEntry, field: EventTermField): string[] {
	const values: string[] = [];
	const push = (value: string | undefined) => {
		if (value && !values.includes(value)) values.push(value);
	};
	push(eventString(entry.data[field]));
	const terms = entry.data.terms;
	if (object(terms)) {
		for (const key of [field, `mec_${field}`]) {
			const list = terms[key];
			if (!Array.isArray(list)) continue;
			for (const term of list) {
				if (object(term)) push(eventString(term.label) ?? eventString(term.name));
			}
		}
	}
	return values;
}

function names(entry: EventEntry, field: string): string[] {
	if (field === "category" || field === "location" || field === "organizer") {
		return eventTermLabels(entry, field);
	}
	const direct = eventString(entry.data[field]);
	return direct ? [direct] : [];
}
export interface EventMonthNavigation {
	month: string;
	prev?: string;
	next?: string;
}

export function eventMonthNavigation(
	view: EventView,
	url: URL,
	now = new Date(),
	timezone?: string,
): EventMonthNavigation | null {
	const key = `events-month[${view.viewSlug}]`;
	const values = url.searchParams.getAll(key);
	if (values.length > 1) return null;
	const month = values[0] ?? eventToday(now, timezone).slice(0, 7);
	if (!EVENT_MONTH_PATTERN.test(month)) return null;
	const year = Number(month.slice(0, 4));
	const index = year * 12 + Number(month.slice(5)) - 1;
	function link(step: number): string | undefined {
		const target = index + step;
		const y = Math.floor(target / 12);
		if (y < 1 || y > 9999) return undefined;
		const m = (target % 12) + 1;
		const next = new URL(url);
		next.searchParams.set(key, `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
		return `${next.pathname}${next.search}${next.hash}`;
	}
	return { month, prev: link(-1), next: link(1) };
}

export interface EventPage {
	events: EventSummary[];
	prev?: string;
	next?: string;
}

export function eventPage(
	events: EventSummary[],
	name: string,
	url: URL,
	pageSize = 10,
): EventPage | null {
	const size = Number.isFinite(pageSize) ? Math.min(50, Math.max(1, Math.floor(pageSize))) : 10;
	const key = `events-page[${name}]`;
	const values = url.searchParams.getAll(key);
	if (values.length > 1) return null;
	const value = values[0] ?? "1";
	if (!EVENT_PAGE_PATTERN.test(value)) return null;
	const page = Number(value);
	if (!Number.isSafeInteger(page) || page > Math.max(1, Math.ceil(events.length / size)))
		return null;
	const offset = (page - 1) * size;
	function link(target: number): string {
		const next = new URL(url);
		if (target === 1) next.searchParams.delete(key);
		else next.searchParams.set(key, String(target));
		return `${next.pathname}${next.search}${next.hash}`;
	}
	return {
		events: events.slice(offset, offset + size),
		prev: page > 1 ? link(page - 1) : undefined,
		next: offset + size < events.length ? link(page + 1) : undefined,
	};
}

export function sortEvents(events: EventSummary[], order: "asc" | "desc" = "asc"): EventSummary[] {
	return events.toSorted((a, b) => {
		const byDate = `${a.date} ${a.startTime ?? ""}`.localeCompare(`${b.date} ${b.startTime ?? ""}`);
		return (order === "asc" ? byDate : -byDate) || a.entry.id.localeCompare(b.entry.id);
	});
}
export function selectEventView(
	events: EventSummary[],
	view: EventView,
	now = new Date(),
	month?: string,
): EventSummary[] {
	const projected = month
		? events.flatMap((event) => {
				const summary = eventSummary(event.entry, now, month, event.referenceTimezone);
				return summary ? [summary] : [];
			})
		: events;
	const selected = projected.filter((event) => {
		const referenceTimezone = event.referenceTimezone ?? event.timezone;
		const today = eventToday(now, referenceTimezone);
		const anchor = view.start === "start_current_month" ? `${today.slice(0, 7)}-01` : today;
		let period = event.period === "upcoming" && event.date >= anchor;
		if (view.mode === "past") {
			// task/12677: MEC fixes this lookback at fifteen years, overflows the year
			// subtraction, then takes the first day of that resulting month.
			const oldest = new Date(`${anchor}T00:00:00Z`);
			oldest.setUTCFullYear(oldest.getUTCFullYear() - 15);
			oldest.setUTCDate(1);
			const cutoff = anchor === today ? eventCurrentClock(now, referenceTimezone) : "23:59:59";
			// Exhausting a recurrence preview does not prove that its series has ended.
			period =
				!event.preview &&
				event.date >= oldest.toISOString().slice(0, 10) &&
				beforeEventCutoff(event.date, event.entry.data.start_time, anchor, cutoff) &&
				beforeEventCutoff(event.endDate ?? event.date, event.entry.data.end_time, anchor, cutoff);
		}
		return (
			period &&
			Object.entries(view.filters ?? {}).every(([field, terms]) =>
				terms.some((term) => names(event.entry, field).includes(term)),
			)
		);
	});
	const sorted = sortEvents(selected, view.order);
	return view.limit === undefined ? sorted : sorted.slice(0, view.limit);
}

/** Plain-text excerpt (~55 words ending in `[…]`) for MEC list-skin event cards. */
export function eventExcerpt(entry: EventEntry, maxWords = 55): string | undefined {
	const raw = eventString(entry.data.excerpt) ?? portableTextPlain(entry.data.content);
	const normalized = raw.replace(/\s+/gu, " ").trim();
	if (!normalized) return undefined;
	const words = normalized.split(" ");
	if (words.length <= maxWords) return normalized;
	return `${words.slice(0, maxWords).join(" ")} […]`;
}

/** Group already-sorted events into consecutive YYYY-MM buckets for month headings. */
export function groupEventsByMonth(
	events: EventSummary[],
): Array<{ month: string; events: EventSummary[] }> {
	const groups: Array<{ month: string; events: EventSummary[] }> = [];
	for (const event of events) {
		const month = event.date.slice(0, 7);
		const last = groups.at(-1);
		if (last && last.month === month) last.events.push(event);
		else groups.push({ month, events: [event] });
	}
	return groups;
}

export type EventDisplayMode = "list" | "monthly";

export function eventViewDisplayMode(view: EventView, url: URL): EventDisplayMode {
	const raw = (url.searchParams.get(`events-view[${view.viewSlug}]`) ?? "").trim().toLowerCase();
	return raw === "monthly" ? "monthly" : "list";
}

export function eventViewTabUrls(view: EventView, url: URL): { list: string; monthly: string } {
	const key = `events-view[${view.viewSlug}]`;
	const pageKey = `events-page[${view.viewSlug}]`;
	const monthKey = `events-month[${view.viewSlug}]`;
	const listUrl = new URL(url);
	listUrl.searchParams.delete(key);
	listUrl.searchParams.delete(monthKey);
	listUrl.searchParams.delete(pageKey);
	const monthlyUrl = new URL(url);
	monthlyUrl.searchParams.set(key, "monthly");
	monthlyUrl.searchParams.delete(pageKey);
	const monthValues = monthlyUrl.searchParams.getAll(monthKey);
	if (
		monthValues.length > 1 ||
		(monthValues.length === 1 && !EVENT_MONTH_PATTERN.test(monthValues[0] ?? ""))
	) {
		monthlyUrl.searchParams.delete(monthKey);
	}
	return {
		list: `${listUrl.pathname}${listUrl.search}${listUrl.hash}`,
		monthly: `${monthlyUrl.pathname}${monthlyUrl.search}${monthlyUrl.hash}`,
	};
}

export interface CalendarDayCell {
	date: string;
	day: number;
	inMonth: boolean;
	events: EventSummary[];
}

/**
 * Build a 7-column (Sun–Sat) calendar grid for `month` (`YYYY-MM`), expanding
 * every occurrence of recurring events that falls inside `month`.
 */
export function eventCalendarGrid(
	entries: EventEntry[],
	view: EventView,
	month: string,
	now = new Date(),
	defaultTimezone?: string,
	searchQuery?: EventSearchQuery | null,
): CalendarDayCell[][] {
	if (!EVENT_MONTH_PATTERN.test(month)) return [];
	const year = Number(month.slice(0, 4));
	const mon = Number(month.slice(5, 7));
	const firstDay = new Date(Date.UTC(year, mon - 1, 1));
	const startDow = firstDay.getUTCDay();
	const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();

	const byDay = new Map<string, EventSummary[]>();
	const pushDay = (d: string, summary: EventSummary) => {
		if (!d.startsWith(`${month}-`)) return;
		const list = byDay.get(d);
		if (list) list.push(summary);
		else byDay.set(d, [summary]);
	};

	const candidates: EventSummary[] = [];
	for (const entry of entries) {
		const base = eventSummary(entry, now, undefined, defaultTimezone);
		if (!base) continue;
		const filterMatch = Object.entries(view.filters ?? {}).every(([field, terms]) =>
			terms.some((term) => names(entry, field).includes(term)),
		);
		if (!filterMatch) continue;
		const occurrences = decodeEventOccurrences(entry.data.occurrences);
		if (base.preview && occurrences) {
			for (const occ of occurrences) {
				if (occ.startsWith(`${month}-`)) {
					candidates.push({ ...base, date: occ });
				}
			}
		} else if (base.date.startsWith(`${month}-`)) {
			candidates.push(base);
		}
	}
	const filtered = searchQuery ? filterEventsBySearch(candidates, searchQuery) : candidates;
	for (const summary of filtered) {
		pushDay(summary.date, summary);
	}
	for (const [k, list] of byDay) byDay.set(k, sortEvents(list, "asc"));

	const cells: CalendarDayCell[] = [];
	const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
	for (let idx = 0; idx < totalCells; idx++) {
		const cellDate = new Date(Date.UTC(year, mon - 1, 1 - startDow + idx));
		const isoDate = cellDate.toISOString().slice(0, 10);
		const inMonth = isoDate.startsWith(`${month}-`);
		cells.push({
			date: isoDate,
			day: cellDate.getUTCDate(),
			inMonth,
			events: inMonth ? (byDay.get(isoDate) ?? []) : [],
		});
	}
	const weeks: CalendarDayCell[][] = [];
	for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
	return weeks;
}
