import {
	getCollectionByUrlPattern,
	getEmDashCollection,
	getEmDashEntry,
	type CacheHint,
} from "emdash";

import { EVENT_URL_PATTERN, type EventEntry } from "./events.js";

export async function loadEvents(locale?: string) {
	const collection = await getCollectionByUrlPattern(EVENT_URL_PATTERN);
	const entries: EventEntry[] = [];
	const hints: CacheHint[] = [];
	if (!collection) return { entries, hints, unavailable: false };
	let cursor: string | undefined;
	const seen = new Set<string>();
	for (let page = 0; page < 50; page++) {
		const result = await getEmDashCollection<string, Record<string, unknown>>(collection.slug, {
			status: "published",
			locale,
			limit: 100,
			cursor,
			orderBy: { created_at: "asc" },
		});
		hints.push(result.cacheHint);
		if (result.error) return { entries: [], hints, unavailable: true };
		entries.push(...result.entries);
		if (!result.hasMore && !result.nextCursor) return { entries, hints, unavailable: false };
		if (!result.nextCursor || seen.has(result.nextCursor))
			return { entries: [], hints, unavailable: true };
		cursor = result.nextCursor;
		seen.add(cursor);
	}
	// A partial scan cannot prove which events are next, particularly for recurrence previews.
	return { entries: [], hints, unavailable: true };
}

export async function loadEvent(slug: string, locale?: string) {
	const collection = await getCollectionByUrlPattern(EVENT_URL_PATTERN);
	if (!collection) return null;
	const result = await getEmDashEntry<string, Record<string, unknown>>(collection.slug, slug, {
		locale,
	});
	if (
		!result.entry ||
		result.isPreview ||
		(result.entry.data.status !== undefined && result.entry.data.status !== "published")
	)
		return null;
	return { ...result, entry: result.entry, collection: collection.slug };
}
