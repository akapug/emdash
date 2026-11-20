import type { ContentEntry } from "emdash";

export const EVENT_URL_PATTERN = "/events/{slug}";
const EVENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const EVENT_MONTH_PATTERN = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/;
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
]);
export type EventEntry = ContentEntry;
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
	let dates: string[] | undefined;
	if (data.occurrences !== undefined && data.occurrences !== null && data.occurrences !== "") {
		try {
			const value: unknown =
				typeof data.occurrences === "string" ? JSON.parse(data.occurrences) : data.occurrences;
			if (!Array.isArray(value) || !value.every(eventDate)) return null;
			dates = [...new Set(value)].toSorted();
		} catch {
			return null;
		}
	}
	const preview = dates !== undefined;
	if (month) {
		if (dates) {
			dates = dates.filter((date) => date.startsWith(`${month}-`));
			if (dates.length === 0) return null;
		} else if (!data.start_date.startsWith(`${month}-`)) return null;
	}
	const upcoming = dates?.find((date) => date >= today);
	const date = upcoming ?? dates?.at(-1) ?? data.start_date;
	const endDate =
		eventDate(data.end_date) && data.end_date >= data.start_date ? data.end_date : undefined;
	let past = (endDate ?? date) < today;
	if (!preview && (endDate ?? date) === today) {
		const cutoff = eventCurrentClock(now, referenceTimezone);
		past =
			beforeEventCutoff(date, data.start_time, today, cutoff) &&
			beforeEventCutoff(endDate ?? date, data.end_time, today, cutoff);
	}
	const allDay =
		data.all_day === true || data.all_day === 1
			? true
			: data.all_day === false || data.all_day === 0
				? false
				: undefined;
	return {
		entry,
		date,
		endDate: preview ? undefined : endDate,
		startTime: allDay ? undefined : clock(data.start_time),
		endTime: allDay ? undefined : clock(data.end_time),
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
	return true;
}

export function parseEventView(value: unknown): EventView | null {
	return isEventView(value) ? value : null;
}

function names(entry: EventEntry, field: string): string[] {
	const values: string[] = [];
	const direct = eventString(entry.data[field]);
	if (direct) values.push(direct);
	const terms = entry.data.terms;
	if (object(terms) && Array.isArray(terms[field])) {
		for (const term of terms[field]) {
			if (object(term)) {
				const label = eventString(term.label) ?? eventString(term.name);
				if (label) values.push(label);
			}
		}
	}
	return values;
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
