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
import { requestCached } from "../request-cache.js";
import { cachedQuery, invalidateObjectCache, CacheNamespace } from "../object-cache/index.js";
import type { StoredVariant } from "../media/variants.js";

/** The widths a renderer may offer, narrowest first. Must match the fork's ladder. */
export const RENDERABLE_VARIANT_WIDTHS = [300, 480, 768, 1024] as const;

/**
 * The committed variants of an image's CURRENT bytes, or `[]`.
 *
 * `parentContentHash` is the parent's `content_hash` — what a Replace rewrites, and
 * therefore what makes an old variant stale. Passing `null` means the parent has
 * no hash, so nothing it once had can be proven current: `[]`.
 */
export async function getCommittedVariants(
	db: Kysely<Database>,
	mediaId: string,
	parentContentHash: string | null,
): Promise<StoredVariant[]> {
	if (!mediaId || !parentContentHash) return [];
	return requestCached(`media-variants:${mediaId}:${parentContentHash}`, () =>
		cachedQuery(
			{
				namespace: CacheNamespace.MEDIA_VARIANTS,
				key: `${mediaId}:${parentContentHash}`,
				load: async () => {
				const rows = await sql<{
					mediaId: string;
					sizeName: string;
					width: number;
					height: number;
					storageKey: string;
					bytes: number;
					contentHash: string;
					parentContentHash: string;
					createdAt: string;
				}>`SELECT media_id AS mediaId, size_name AS sizeName, width, height,
					storage_key AS storageKey, bytes, content_hash AS contentHash,
					parent_content_hash AS parentContentHash, created_at AS createdAt
					FROM _emdash_media_variants
					WHERE media_id = ${mediaId} AND parent_content_hash = ${parentContentHash}
					ORDER BY width ASC`.execute(db);
				return rows.rows as StoredVariant[];
			},
		}),
	);
}

/**
 * The widths to put in a `srcset` for an image whose committed variants are
 * `variants` and which renders at `renderedWidth`.
 *
 * EMPTY when there is nothing to offer: no variants, or none narrower than the
 * image renders. Empty is the contract that keeps the markup identical to a site
 * with no variants, so it is a correct answer rather than a failure.
 */
export function srcsetWidthsFor(variants: readonly StoredVariant[], renderedWidth: number | undefined): number[] {
	if (!renderedWidth || renderedWidth <= 0) return [];
	return variants
		.map((v) => v.width)
		.filter((w) => Number.isInteger(w) && w > 0 && w < renderedWidth)
		.sort((a, b) => a - b)
		.filter((w, i, all) => all.indexOf(w) === i);
}

/**
 * Every path that changes variant rows must call this, or a warm page keeps
 * serving a srcset for variants that no longer exist.
 */
export async function invalidateVariants(): Promise<void> {
	await invalidateObjectCache(CacheNamespace.MEDIA_VARIANTS);
}
