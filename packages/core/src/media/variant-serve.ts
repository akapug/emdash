/**
 * Resolve `?w=` on a parent's public media URL to a committed variant.
 *
 * THE ROUTE'S CONTRACT, in one place so the route stays a caller:
 *
 *  - `w` absent, unparseable, or not a stored width  -> `null`, the original is
 *    served. Every one of those is a MISS, not an error: a stale `srcset` whose
 *    variant was retired must still render, and the parent's bytes are the correct
 *    answer for any width we cannot improve on.
 *  - the parent is gone, not ready, or has no content hash -> `null`.
 *  - the row must match the parent's current hash. If the committed object is
 *    missing, the file route (which owns storage) falls back to the original.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

export interface ResolvedVariant {
	storageKey: string;
	width: number;
}

/**
 * `key` is the parent's storage key, as the public URL carries it. `w` is the query
 * value, unvalidated by design — the caller passes what arrived.
 */
export async function resolveVariantForRequest(
	db: Kysely<Database>,
	key: string,
	w: string | null,
): Promise<ResolvedVariant | null> {
	if (!w) return null;
	const width = Number(w);
	// A width we cannot use is a miss, not a rejection: `?w=abc` serves the original
	// exactly as `?w=` would, and neither is an error the browser can act on.
	if (!Number.isInteger(width) || width <= 0) return null;

	return (
		(await db
			.selectFrom("_emdash_media_variants as variant")
			.innerJoin("media as parent", "parent.id", "variant.media_id")
			.select(["variant.storage_key as storageKey", "variant.width"])
			.where("parent.storage_key", "=", key)
			.where("parent.status", "=", "ready")
			.where("variant.width", "=", width)
			.whereRef("variant.parent_content_hash", "=", "parent.content_hash")
			.limit(1)
			.executeTakeFirst()) ?? null
	);
}
