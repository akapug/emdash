import { eventString, eventTermLabels, type EventSummary } from "./events.js";

const COMPACT_DATE_DASHES = /-/g;
const COMPACT_TIME_COLONS = /:/g;
const IANA_ZONE_PATTERN = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;

function addCivilDays(isoDate: string, days: number): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function compactDate(isoDate: string): string {
	return isoDate.replace(COMPACT_DATE_DASHES, "");
}

function normalizeClockHms(clock: string): string {
	const withSec = clock.length === 5 ? `${clock}:00` : clock;
	return withSec.replace(COMPACT_TIME_COLONS, "");
}

function addOneHour(isoDate: string, clock: string): { date: string; hms: string } {
	const [hh, mm, ss] = (clock.length === 5 ? `${clock}:00` : clock).split(":").map(Number);
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCHours((hh ?? 0) + 1, mm ?? 0, ss ?? 0, 0);
	return {
		date: d.toISOString().slice(0, 10),
		hms: d.toISOString().slice(11, 19).replace(COMPACT_TIME_COLONS, ""),
	};
}

function validIanaZone(zone?: string): string | undefined {
	if (!zone || !IANA_ZONE_PATTERN.test(zone)) return undefined;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
			? zone
			: undefined;
	} catch {
		return undefined;
	}
}

function eventLocationLine(event: EventSummary): string {
	const names = eventTermLabels(event.entry, "location");
	const address = eventString(event.entry.data.location_address);
	const parts: string[] = [];
	if (names.length > 0) parts.push(names.join(", "));
	if (address) parts.push(address);
	return parts.join(", ");
}

function plainDescription(event: EventSummary): string {
	const content = event.entry.data.content;
	if (!Array.isArray(content)) return "";
	const chunks: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || !("children" in block)) continue;
		const children: unknown = block.children;
		if (!Array.isArray(children)) continue;
		const text = children
			.map((c: unknown) =>
				c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "",
			)
			.join("")
			.trim();
		if (text) chunks.push(text);
	}
	return chunks.join("\n\n").slice(0, 1000);
}

interface ResolvedSpan {
	allDay: boolean;
	startDate: string;
	endDate: string;
	startHms?: string;
	endHms?: string;
	timezone?: string;
}

function resolveCalendarSpan(event: EventSummary, siteTimezone?: string): ResolvedSpan {
	const zone = validIanaZone(event.timezone ?? event.referenceTimezone ?? siteTimezone);
	const startDate = event.date;
	const baseEndDate = event.endDate && event.endDate >= startDate ? event.endDate : startDate;

	if (event.allDay || !event.startTime) {
		return {
			allDay: true,
			startDate,
			// RFC 5545 / Google Calendar all-day end date is exclusive.
			endDate: addCivilDays(baseEndDate, 1),
			timezone: zone,
		};
	}

	const startHms = normalizeClockHms(event.startTime);
	if (event.endTime) {
		const endHms = normalizeClockHms(event.endTime);
		const overnight = baseEndDate === startDate && endHms < startHms;
		return {
			allDay: false,
			startDate,
			endDate: overnight ? addCivilDays(startDate, 1) : baseEndDate,
			startHms,
			endHms,
			timezone: zone,
		};
	}

	const plusHour = addOneHour(baseEndDate, event.startTime);
	return {
		allDay: false,
		startDate,
		endDate: plusHour.date,
		startHms,
		endHms: plusHour.hms,
		timezone: zone,
	};
}

/**
 * Build a plain "+ Add to Google Calendar" URL from the event's own fields.
 * Uses the event's resolved occurrence (`event.date`) and timezone (`ctz`),
 * handling all-day and overnight events without any third-party service.
 */
export function googleCalendarUrl(
	event: EventSummary,
	pageUrl?: string,
	siteTimezone?: string,
): string {
	const title = eventString(event.entry.data.title) ?? event.entry.id;
	const span = resolveCalendarSpan(event, siteTimezone);
	// NO KNOWN ZONE MEANS A FLOATING TIME, NEVER UTC. MEASURED 2026-11-25 on a site imported
	// before the site timezone was carried: a 19:00 event was exported as 19:00Z, which a
	// calendar in New York shows at 2 pm. Without a zone the honest statement is "19:00 on
	// the wall clock", which is what an undecorated time means to Google and to RFC 5545.
	const dates = span.allDay
		? `${compactDate(span.startDate)}/${compactDate(span.endDate)}`
		: span.timezone
			? `${compactDate(span.startDate)}T${span.startHms}/${compactDate(span.endDate)}T${span.endHms}`
			: `${compactDate(span.startDate)}T${span.startHms}/${compactDate(span.endDate)}T${span.endHms}`;

	const params = new URLSearchParams();
	params.set("action", "TEMPLATE");
	params.set("text", title);
	params.set("dates", dates);
	if (!span.allDay && span.timezone) {
		params.set("ctz", span.timezone);
	}
	const detailsParts: string[] = [];
	const desc = plainDescription(event);
	if (desc) detailsParts.push(desc);
	if (pageUrl) detailsParts.push(pageUrl);
	if (detailsParts.length > 0) {
		params.set("details", detailsParts.join("\n\n"));
	}
	const loc = eventLocationLine(event);
	if (loc) params.set("location", loc);
	return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function escapeIcsText(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll(";", "\\;")
		.replaceAll(",", "\\,")
		.replaceAll("\r\n", "\\n")
		.replaceAll("\n", "\\n")
		// A bare CR is not a line break in RFC 5545 but some readers treat it as one.
		.replaceAll("\r", "");
}

function deterministicDtStamp(event: EventSummary): string {
	const raw = eventString(event.entry.data.updated_at) ?? eventString(event.entry.data.created_at);
	if (raw) {
		const parsed = new Date(raw);
		if (Number.isFinite(parsed.getTime())) {
			return `${parsed.toISOString().slice(0, 19).replace(COMPACT_DATE_DASHES, "").replace(COMPACT_TIME_COLONS, "")}Z`;
		}
	}
	return `${compactDate(event.date)}T000000Z`;
}

/**
 * Build a small RFC 5545 `text/calendar` (.ics) payload for one event.
 * Deterministic (no wall-clock `new Date()`), respects event timezone, all-day,
 * overnight intervals, and recurring next occurrence (`event.date`).
 */
export function buildEventIcs(
	event: EventSummary,
	pageUrl?: string,
	siteTimezone?: string,
): string {
	const title = eventString(event.entry.data.title) ?? event.entry.id;
	const span = resolveCalendarSpan(event, siteTimezone);
	const host = (() => {
		try {
			return pageUrl ? new URL(pageUrl).host : "events.local";
		} catch {
			return "events.local";
		}
	})();
	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//EmDash//Event Export//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"BEGIN:VEVENT",
		`UID:${escapeIcsText(`${event.entry.id}-${event.date}@${host}`)}`,
		`DTSTAMP:${deterministicDtStamp(event)}`,
	];

	if (span.allDay) {
		lines.push(`DTSTART;VALUE=DATE:${compactDate(span.startDate)}`);
		lines.push(`DTEND;VALUE=DATE:${compactDate(span.endDate)}`);
	} else if (span.timezone) {
		lines.push(`DTSTART;TZID=${span.timezone}:${compactDate(span.startDate)}T${span.startHms}`);
		lines.push(`DTEND;TZID=${span.timezone}:${compactDate(span.endDate)}T${span.endHms}`);
	} else {
		// Floating local time (RFC 5545 form 1): see googleCalendarUrl above for why not "Z".
		lines.push(`DTSTART:${compactDate(span.startDate)}T${span.startHms}`);
		lines.push(`DTEND:${compactDate(span.endDate)}T${span.endHms}`);
	}

	lines.push(`SUMMARY:${escapeIcsText(title)}`);
	const loc = eventLocationLine(event);
	if (loc) lines.push(`LOCATION:${escapeIcsText(loc)}`);
	const desc = plainDescription(event);
	if (desc) lines.push(`DESCRIPTION:${escapeIcsText(desc)}`);
	if (pageUrl) lines.push(`URL:${pageUrl}`);
	if (event.cancelled) lines.push("STATUS:CANCELLED");

	lines.push("END:VEVENT", "END:VCALENDAR", "");
	return lines.join("\r\n");
}
