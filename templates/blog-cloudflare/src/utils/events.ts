import type { ContentEntry } from "emdash";

export const EVENT_URL_PATTERN = "/events/{slug}";
export type EventEntry = ContentEntry<Record<string, unknown>>;
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
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function clock(value: unknown): string | undefined {
	return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
		? value
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
			dates = [...new Set(value)].sort();
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
		period: preview
			? upcoming
				? "upcoming"
				: "preview"
			: (endDate ?? date) >= today
				? "upcoming"
				: "past",
	};
}

export function parseEventView(value: unknown): EventView | null {
	if (!object(value)) return null;
	const keys = [
		"version",
		"viewSlug",
		"mode",
		"order",
		"layout",
		"start",
		"limit",
		"navigation",
		"filters",
	];
	if (
		Object.keys(value).some((key) => !keys.includes(key)) ||
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
		return null;
	if (value.filters !== undefined) {
		if (!object(value.filters)) return null;
		for (const [key, terms] of Object.entries(value.filters)) {
			if (
				!["category", "location", "organizer"].includes(key) ||
				!Array.isArray(terms) ||
				terms.length === 0 ||
				terms.length > 100 ||
				!terms.every((term) => typeof term === "string" && term.trim().length > 0)
			)
				return null;
		}
	}
	return value as EventView;
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
	if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return null;
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
				const summary = eventSummary(event.entry, now, month);
				return summary ? [summary] : [];
			})
		: events;
	const selected = projected.filter((event) => {
		const today = eventToday(now, event.timezone);
		const anchor = view.start === "start_current_month" ? `${today.slice(0, 7)}-01` : today;
		let period = event.period === "upcoming" && event.date >= anchor;
		if (view.mode === "past") {
			const oldest = new Date(`${anchor}T00:00:00Z`);
			oldest.setUTCFullYear(oldest.getUTCFullYear() - 15);
			period = event.period === "past" && event.date >= oldest.toISOString().slice(0, 10) && event.date <= anchor;
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
