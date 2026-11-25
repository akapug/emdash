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
 *  - a row exists but its bytes are not in storage -> `null`, so a half-written
 *    variant degrades to the original rather than to a 500.
 *  - the row's `parent_content_hash` differs from the parent's CURRENT hash ->
 *    `null`. That is the replace case: the image behind the URL changed, so every
 *    size of the old image is invisible without anyone sweeping it.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../database/types.js";

export interface ResolvedVariant {
	storageKey: string;
	width: number;
	contentType: string;
}

/** The variant's content type follows the parent's: we never store a format change. */
function contentTypeFor(mimeType: string | null): string {
	return mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg";
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

	const rows = await sql<{
		storageKey: string;
		width: number;
		mimeType: string | null;
		parentContentHash: string;
		currentContentHash: string | null;
	}>`SELECT v.storage_key AS storageKey, v.width AS width, m.mime_type AS mimeType,
		v.parent_content_hash AS parentContentHash, m.content_hash AS currentContentHash
		FROM _emdash_media_variants v
		JOIN media m ON m.id = v.media_id
		WHERE m.storage_key = ${key}
			AND m.status = 'ready'
			AND v.width = ${width}
			AND v.parent_content_hash = m.content_hash
		LIMIT 1`.execute(db);

	const row = rows.rows[0];
	if (!row) return null;
	// The join already required the hashes to agree; this is the guard that says the
	// parent has one at all, since `m.content_hash` can be NULL on a legacy row.
	if (!row.currentContentHash || row.parentContentHash !== row.currentContentHash) return null;

	return {
		storageKey: row.storageKey,
		width: row.width,
		contentType: contentTypeFor(row.mimeType),
	};
}
