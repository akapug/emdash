/**
 * Collection info query for Astro templates.
 *
 * Same pattern as getMenu() / getComments() — uses getDb() for ambient DB access.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { cachedQuery, CacheNamespace } from "../object-cache/index.js";
import { requestCached } from "../request-cache.js";
import { SchemaError, SchemaRegistry } from "./registry.js";
import type { Collection } from "./types.js";

/**
 * Get collection metadata by slug.
 *
 * @example
 * ```ts
 * import { getCollectionInfo } from "emdash";
 *
 * const info = await getCollectionInfo("posts");
 * if (info?.commentsEnabled) {
 *   // render comment UI
 * }
 * ```
 */
export async function getCollectionInfo(slug: string): Promise<Collection | null> {
	return requestCached(`collection-info:${slug}`, () =>
		cachedQuery({
			namespace: CacheNamespace.SCHEMA,
			key: `collection-info:${slug}`,
			load: async () => {
				const db = await getDb();
				return getCollectionInfoWithDb(db, slug);
			},
		}),
	);
}

/** Discover a routable collection without depending on its name or an existing entry. */
export async function getCollectionByUrlPattern(pattern: string): Promise<Collection | null> {
	return requestCached(`collection-url-pattern:${pattern}`, () =>
		cachedQuery({
			namespace: CacheNamespace.SCHEMA,
			key: `collection-url-pattern:${pattern}`,
			load: async () => {
				const registry = new SchemaRegistry(await getDb());
				const collections = (await registry.listCollections()).filter(
					(collection) => collection.routable && collection.urlPattern === pattern,
				);
				if (collections.length > 1) {
					throw new SchemaError(
						`Ambiguous collection URL pattern "${pattern}"`,
						"AMBIGUOUS_URL_PATTERN",
						{ pattern },
					);
				}
				return collections[0] ?? null;
			},
		}),
	);
}

/**
 * Get collection metadata with an explicit db handle.
 *
 * @internal Use `getCollectionInfo()` in templates. This variant is for
 * routes that already have a database handle.
 */
export async function getCollectionInfoWithDb(
	db: Kysely<Database>,
	slug: string,
): Promise<Collection | null> {
	const registry = new SchemaRegistry(db);
	return registry.getCollection(slug);
}
