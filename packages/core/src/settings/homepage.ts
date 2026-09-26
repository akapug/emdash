/**
 * The site's chosen homepage entry, resolved for the current request.
 */

import { siteSettingsTag } from "../cache/chrome-tags.js";
import { resolveLocale, resolveLocaleChain } from "../i18n/resolve.js";
import { loadEntriesByGroups } from "../loader.js";
import { cachedQuery, contentCacheNamespaces } from "../object-cache/index.js";
import { getEmDashEntry, type EntryResult } from "../query.js";
import { requestCached } from "../request-cache.js";
import { getRequestContext } from "../request-context.js";
import { getSiteSettings } from "./index.js";

export interface HomepageResult<D = Record<string, unknown>> extends EntryResult<D> {
	/** The collection the homepage entry belongs to, or `null` when no homepage is set. */
	collection: string | null;
}

interface HomepageVariant {
	id: string;
	locale: string | null;
}

/**
 * Get the entry chosen as the site's homepage.
 *
 * Returns `entry: null` when no homepage is set, and also when the chosen entry
 * has been deleted or has no published variant, so a template can render its
 * default homepage instead. The entry is resolved in the request's locale,
 * falling back through the configured locale chain; preview and edit mode see
 * drafts exactly as they do through `getEmDashEntry()`.
 *
 * @example
 * ```astro
 * ---
 * import { getHomepage } from "emdash";
 *
 * const { entry: page, cacheHint } = await getHomepage();
 * if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
 * ---
 * {page ? <h1>{page.data.title}</h1> : <LatestPosts />}
 * ```
 */
export function getHomepage<D = Record<string, unknown>>(
	options: { locale?: string } = {},
): Promise<HomepageResult<D>> {
	return requestCached(`homepage:${options.locale ?? ""}`, () => resolveHomepage<D>(options));
}

async function resolveHomepage<D>(options: { locale?: string }): Promise<HomepageResult<D>> {
	const { homepage } = await getSiteSettings();
	// Every result depends on the setting, so every hint carries its tag:
	// choosing a homepage has to invalidate the route that rendered without one.
	const settingsTag = siteSettingsTag();
	if (!homepage) {
		return { entry: null, collection: null, isPreview: false, cacheHint: { tags: [settingsTag] } };
	}

	const { collection } = homepage;
	// A homepage also depends on its collection, resolved or not: publishing a
	// translation that is missing, or the entry while it is a draft, has to
	// invalidate the route that fell back.
	const tags = [collection, settingsTag];
	const unresolved: HomepageResult<D> = {
		entry: null,
		collection,
		isPreview: false,
		cacheHint: { tags },
	};

	const ctx = getRequestContext();
	const serveDrafts = !!ctx?.editMode || ctx?.preview?.collection === collection;
	const localeChain = resolveLocaleChain(options.locale);
	let variant: HomepageVariant | null;
	try {
		variant = await cachedQuery<HomepageVariant | null>({
			namespace: contentCacheNamespaces(collection),
			key: `homepage:${homepage.id}|loc=${localeChain.join(",")}|drafts=${serveDrafts}`,
			load: async () => {
				const [loaded] = await loadEntriesByGroups(collection, [homepage.id], {
					publishedOnly: !serveDrafts,
					localeChain,
				});
				const { id, locale } = loaded?.data ?? {};
				if (typeof id !== "string") return null;
				return { id, locale: typeof locale === "string" ? locale : null };
			},
		});
	} catch (error) {
		return { ...unresolved, error: error instanceof Error ? error : new Error(String(error)) };
	}
	if (!variant) return unresolved;

	const result = await getEmDashEntry<string, D>(collection, variant.id, {
		locale: options.locale,
	});
	if (!result.entry) return { ...result, ...unresolved };

	const requestedLocale = resolveLocale(options.locale);
	const fallbackLocale =
		variant.locale && requestedLocale && variant.locale !== requestedLocale
			? variant.locale
			: result.fallbackLocale;
	const cacheHint = {
		...result.cacheHint,
		tags: [...new Set([...(result.cacheHint.tags ?? []), ...tags])],
	};
	return { ...result, collection, fallbackLocale, cacheHint };
}
