/**
 * Tenant-side canonical public URL path resolution by `(collection, entryId)`.
 *
 * Resolves each entry against:
 * - the live published row (never drafts, scheduled, or deleted rows),
 * - public-visibility checks (`routable`, non-empty slug, not password-protected),
 * - the site's configured homepage override and collection `url_pattern`,
 * - the runtime i18n and trailing-slash routing policy.
 *
 * Abstains (`null`) on unknown routes, including carried collections whose
 * schema does not describe a `url_pattern`, unresolved date/route tokens, and
 * locales outside the configured i18n list.
 */

import type { Kysely } from "kysely";

import { ContentRepository } from "../database/repositories/content.js";
import { ProtectedContentRepository } from "../database/repositories/protected-content.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getI18nConfig } from "../i18n/config.js";
import { localizePath, resolveLocalizedContentRoutePath } from "../i18n/resolve.js";
import { SchemaRegistry } from "../schema/registry.js";
import { getSiteSettingWithDb } from "../settings/index.js";

/** Built-in template collections that have standard routes even without an explicit `url_pattern`. */
const STANDARD_TEMPLATE_COLLECTIONS = new Set(["pages", "posts"]);
const UNRESOLVED_TOKEN_RE = /\{[^}]+\}/;
const TRAILING_SLASH_RE = /\/$/;

export interface PublicContentPathRef {
	collection: string;
	id: string;
}

export interface ResolvedPublicContentPath {
	collection: string;
	id: string;
	path: string | null;
}

export interface ResolvePublicContentPathOptions {
	trailingSlash?: "always" | "never" | "ignore";
}

async function getHostTrailingSlash(): Promise<"always" | "never" | "ignore"> {
	try {
		const mod: unknown = await import("virtual:emdash/config");
		if (typeof mod !== "object" || mod === null || !("default" in mod)) return "ignore";
		const def: unknown = mod.default;
		if (typeof def !== "object" || def === null || !("trailingSlash" in def)) return "ignore";
		const ts: unknown = def.trailingSlash;
		if (ts === "always" || ts === "never" || ts === "ignore") return ts;
		return "ignore";
	} catch {
		return "ignore";
	}
}

function applyTrailingSlash(path: string, trailingSlash: "always" | "never" | "ignore"): string {
	if (trailingSlash === "always" && path !== "/") return `${path}/`;
	if (trailingSlash === "never" && path !== "/") return path.replace(TRAILING_SLASH_RE, "");
	return path;
}

/**
 * Resolve canonical public relative paths for a batch of `(collection, id)`
 * references. Returns one result per input reference in the same order, with
 * `path: null` whenever the entry is not publicly routable.
 */
export async function resolvePublicContentPaths(
	db: Kysely<Database>,
	refs: readonly PublicContentPathRef[],
	options: ResolvePublicContentPathOptions = {},
): Promise<ResolvedPublicContentPath[]> {
	if (refs.length === 0) return [];

	const contentRepo = new ContentRepository(db);
	const protectedRepo = new ProtectedContentRepository(db);
	const registry = new SchemaRegistry(db);
	const [homepage, trailingSlash] = await Promise.all([
		getSiteSettingWithDb("homepage", db),
		options.trailingSlash ? Promise.resolve(options.trailingSlash) : getHostTrailingSlash(),
	]);
	const defaultLocale = getI18nConfig()?.defaultLocale ?? "en";

	type ResolvedCollection = Awaited<ReturnType<SchemaRegistry["getCollection"]>>;
	const collectionCache = new Map<string, ResolvedCollection>();
	const getCollection = async (slug: string): Promise<ResolvedCollection> => {
		if (collectionCache.has(slug)) return collectionCache.get(slug) ?? null;
		try {
			validateIdentifier(slug, "collection slug");
		} catch {
			collectionCache.set(slug, null);
			return null;
		}
		const info = await registry.getCollection(slug);
		collectionCache.set(slug, info);
		return info;
	};

	const results: ResolvedPublicContentPath[] = [];
	for (const ref of refs) {
		const collectionInfo = await getCollection(ref.collection);
		if (!collectionInfo || !collectionInfo.routable) {
			results.push({ collection: ref.collection, id: ref.id, path: null });
			continue;
		}

		const item = await contentRepo.findById(ref.collection, ref.id);
		if (!item || item.status !== "published" || !item.slug || item.slug.trim() === "") {
			results.push({ collection: ref.collection, id: ref.id, path: null });
			continue;
		}

		const protectedRow = await protectedRepo.find(ref.collection, item.id);
		if (protectedRow) {
			results.push({ collection: ref.collection, id: ref.id, path: null });
			continue;
		}

		const locale = item.locale || defaultLocale;
		const isHomepage =
			homepage != null &&
			homepage.collection === ref.collection &&
			(homepage.id === item.translationGroup || homepage.id === item.id);

		if (isHomepage) {
			const localizedHome = await localizePath("/", locale);
			results.push({
				collection: ref.collection,
				id: ref.id,
				path: localizedHome === null ? null : applyTrailingSlash(localizedHome, trailingSlash),
			});
			continue;
		}

		if (!collectionInfo.urlPattern && !STANDARD_TEMPLATE_COLLECTIONS.has(ref.collection)) {
			results.push({ collection: ref.collection, id: ref.id, path: null });
			continue;
		}

		const resolved = await resolveLocalizedContentRoutePath({
			pattern: collectionInfo.urlPattern ?? null,
			collection: ref.collection,
			slug: item.slug,
			id: item.id,
			date: item.publishedAt,
			locale,
			trailingSlash,
		});
		const safePath = resolved === null || UNRESOLVED_TOKEN_RE.test(resolved) ? null : resolved;
		results.push({ collection: ref.collection, id: ref.id, path: safePath });
	}

	return results;
}
