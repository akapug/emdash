/**
 * The sizes a rendered image may offer, read once per request.
 *
 * WHY THIS FILE EXISTS. The markup must never offer a width it cannot serve. An
 * earlier version built a srcset from a fixed ladder whether or not a variant
 * existed, which on every tenant alive today promises `300w` over a 9.6 MB
 * original — worse than no srcset, because the browser believes it.
 *
 * So the renderer asks what is COMMITTED, and no variants means no srcset and the
 * markup stays byte-identical to a site with no variants at all.
 *
 * TWO CACHES, deliberately:
 *
 *  - `requestCached` is the per-request store: twenty `<Image>` components naming
 *    the same media id in one page share ONE in-flight query, and the entry dies
 *    with the request. It no-ops outside a request (the repro render tests), which
 *    is why the render arms must work with it absent.
 *  - `cachedQuery` under its own namespace is the cross-request cache, so a warm
 *    page costs no variant reads at all. Every write path (store, retire, delete,
 *    replace) invalidates that namespace.
 *
 * THE PAGE CACHE. The rendered HTML now depends on variant rows, so a backfill
 * that adds variants must be able to make cached pages refill. That is what the
 * page generation vector is for, and it is built from a FIXED list of namespaces
 * (`PAGE_VECTOR_NAMESPACES` in object-cache/index.ts). `MEDIA_VARIANTS` is in that
 * list, so a backfill's invalidation moves the vector and stale pages refill.
 * If it were omitted, staleness would be bounded only by the route's TTL — and a
 * stale srcset is safe by design (a hint with no committed variant serves the
 * original), but "safe" is not the same as "correct", and the vector is one line.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../database/types.js";
import type { StoredVariant } from "../media/variants.js";
import { cachedQuery, invalidateObjectCache, CacheNamespace } from "../object-cache/index.js";
import { requestCached } from "../request-cache.js";

/** The widths a renderer may offer, narrowest first. Must match the fork's ladder. */
export const RENDERABLE_VARIANT_WIDTHS = [300, 480, 768, 1024] as const;

/**
 * The committed variants of an image's CURRENT bytes, or `[]`.
 *
 * THE BINDING IS IN SQL, NOT IN THE IMAGE VALUE. Measured on a real tenant's stored
 * content: an image value is a URL holding a STORAGE KEY
 * (`/_emdash/api/media/file/01M87...jpg`) and carries NO content hash. Passing one in
 * would have meant the read silently never matched, and a stale value handed in by a
 * caller would have been trusted. So the caller passes what it has — an id, a storage
 * key, or a url holding one — and the JOIN decides currency:
 *
 *     variants.parent_content_hash = media.content_hash
 *
 * A replaced parent's rows therefore stop matching on the next read, with nobody
 * sweeping them. The cache key needs no hash either, because store, retire, delete
 * and replace all invalidate the namespace.
 */
export async function getCommittedVariants(
	db: Kysely<Database>,
	ref: VariantMediaRef,
): Promise<StoredVariant[]> {
	// ONE PATH FOR EVERY BRANCH. Measured on a real tenant, an image value is a url
	// holding a storage key and carries neither an id nor a hash — so the id branch and
	// the cover/card branch asked the same question and deserved the same code. The
	// storage key is unique on `media`, so resolving by it reaches the one row.
	const storageKey = ref.storageKey ?? storageKeyOf(ref.url ?? null) ?? ref.url ?? null;
	if (!storageKey) return [];
	return requestCached(`media-variants:${storageKey}`, () =>
		cachedQuery({
			namespace: CacheNamespace.MEDIA_VARIANTS,
			key: storageKey,
			load: async () => {
				// The hash binding stays in SQL: a replaced parent's rows stop matching
				// without anyone sweeping them, and no caller can hand in a stale hash.
				const rows = await sql<StoredVariant>`
					SELECT v.media_id AS mediaId, v.size_name AS sizeName, v.width, v.height,
						v.storage_key AS storageKey, v.bytes, v.content_hash AS contentHash,
						v.parent_content_hash AS parentContentHash, v.created_at AS createdAt
					FROM _emdash_media_variants v
					JOIN media m ON m.id = v.media_id
					WHERE m.status = 'ready'
						AND m.content_hash IS NOT NULL
						AND v.parent_content_hash = m.content_hash
						AND m.storage_key = ${storageKey}
					ORDER BY v.width ASC`.execute(db);
				return [...rows.rows];
			},
		}),
	);
}

/** What a caller has in hand. Any one of these is enough. */
export interface VariantMediaRef {
	/** The storage key, e.g. `2024/01/photo.jpg`. */
	storageKey?: string | null;
	/** A public url that holds a storage key, e.g. `/_emdash/api/media/file/<key>`. */
	url?: string | null;
}

const INTERNAL_PREFIX = "/_emdash/api/media/file/";
/** A url's query or fragment: neither is part of the key. */
const URL_SUFFIX = /[?#]/;

/** The storage key inside a public media url, or null when the url is not one. */
function storageKeyOf(url: string | null): string | null {
	if (!url) return null;
	const at = url.indexOf(INTERNAL_PREFIX);
	if (at === -1) return null;
	const key = url.slice(at + INTERNAL_PREFIX.length).split(URL_SUFFIX)[0];
	return key || null;
}

/**
 * The widths to put in a `srcset` for an image whose committed variants are
 * `variants` and which renders at `renderedWidth`.
 *
 * EMPTY when there is nothing to offer: no variants, or none narrower than the
 * image renders. Empty is the contract that keeps the markup identical to a site
 * with no variants, so it is a correct answer rather than a failure.
 */
export function srcsetWidthsFor(
	variants: readonly StoredVariant[],
	renderedWidth: number | undefined,
): number[] {
	if (!renderedWidth || renderedWidth <= 0) return [];
	return variants
		.map((v) => v.width)
		.filter((w) => Number.isInteger(w) && w > 0 && w < renderedWidth)
		.toSorted((a, b) => a - b)
		.filter((w, i, all) => all.indexOf(w) === i);
}

/**
 * Every path that changes variant rows must call this, or a warm page keeps
 * serving a srcset for variants that no longer exist.
 */
export function invalidateVariants(): void {
	invalidateObjectCache(CacheNamespace.MEDIA_VARIANTS);
}
