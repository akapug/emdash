import type { APIRoute } from "astro";
import { decodeSlug, getSiteSettingsWithCacheHint } from "emdash";

import { buildEventIcs } from "../../utils/event-calendar-export.js";
import { loadEvent } from "../../utils/event-data.js";
import { boundEventPageCache } from "../../utils/event-page-cache.js";
import { eventString, eventSummary } from "../../utils/events.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, currentLocale }) => {
	const slug = decodeSlug(params.slug);
	if (!slug) return new Response(null, { status: 404 });
	const result = await loadEvent(slug, currentLocale);
	if (!result) return new Response(null, { status: 404 });

	const site = await getSiteSettingsWithCacheHint();
	const siteTimezone = eventString(site.data.timezone);
	const now = new Date();
	const event = eventSummary(result.entry, now, undefined, siteTimezone);
	if (!event) return new Response(null, { status: 404 });
	if (event.preview) boundEventPageCache([event], now, siteTimezone);

	const pageUrl = new URL(`/events/${encodeURIComponent(slug)}/`, url.origin).toString();
	const body = buildEventIcs(event, pageUrl, siteTimezone);
	const safeFile = slug.replace(/[^a-zA-Z0-9._-]/g, "-") || "event";

	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": `attachment; filename="${safeFile}.ics"`,
			// Five minutes for every event: an edited date must not sit in a browser for an hour.
			"Cache-Control": "public, max-age=300",
		},
	});
};
