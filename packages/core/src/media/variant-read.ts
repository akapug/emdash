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

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { localMediaFileUrl } from "../media/url.js";
import { variantUrl, type StoredVariant } from "../media/variants.js";
import { cachedQuery, invalidateObjectCache, CacheNamespace } from "../object-cache/index.js";
import { capPageCacheUntil } from "../page-cache/state.js";
import { requestCached } from "../request-cache.js";

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
): Promise<CommittedVariant[]> {
	// ONE PATH FOR EVERY BRANCH. Measured on a real tenant, an image value is a url
	// holding a storage key and carries neither an id nor a hash — so the id branch and
	// the cover/card branch asked the same question and deserved the same code. The
	// storage key is unique on `media`, so resolving by it reaches the one row.
	const storageKey = ref.storageKey ?? storageKeyOf(ref.url ?? null) ?? ref.url ?? null;
	if (!storageKey) return [];
	return requestCached(`media-variants:${storageKey}`, () =>
		cachedQuery({
			namespace: CacheNamespace.MEDIA_VARIANTS,
			// Versioned: an entry cached before the parent's dimensions were selected
			// lacks them, and must refill rather than be read as "unknown".
			key: `v2:${storageKey}`,
			load: () =>
				db
					.selectFrom("_emdash_media_variants as variant")
					.innerJoin("media as parent", "parent.id", "variant.media_id")
					.select([
						"variant.media_id as mediaId",
						"variant.size_name as sizeName",
						"variant.width",
						"variant.height",
						"variant.storage_key as storageKey",
						"variant.bytes",
						"variant.content_hash as contentHash",
						"variant.parent_content_hash as parentContentHash",
						"variant.created_at as createdAt",
						"parent.width as parentWidth",
						"parent.height as parentHeight",
					])
					.where("parent.status", "=", "ready")
					.whereRef("variant.parent_content_hash", "=", "parent.content_hash")
					.where("parent.storage_key", "=", storageKey)
					.orderBy("variant.width", "asc")
					.execute(),
		}),
	);
}

/**
 * A committed variant, with the stored dimensions of the image it was made from.
 * A content image can be stored with no dimensions of its own, and the parent's
 * are then the only honest bound on how wide the image is ever drawn.
 */
export type CommittedVariant = StoredVariant & {
	parentWidth: number | null;
	parentHeight: number | null;
};

/** How long a page that could not read its variants may be cached. */
const VARIANT_READ_RETRY_MS = 60_000;
let lastReadFailureWarning = 0;

/**
 * The committed variants for an image a page is drawing, or `[]`.
 *
 * A component must not gate this read on `Astro.locals.emdash.db`. Only a
 * logged-in request has that: the middleware's anonymous path attaches a partial
 * handler object with no `db`, and every public read (menus, settings, content)
 * reaches the database through `getDb()` and the request context instead. A read
 * gated on the handler therefore never runs for a visitor, which is the request
 * that matters.
 *
 * Never throws, because an image must still render when the read cannot run. The
 * two reasons are kept apart:
 *
 *  - NO DATABASE (a static build, a render test) is expected and silent.
 *  - A FAILED READ is not expected. It is logged, at most once a minute, and the
 *    page's cache lifetime is capped so the HTML written without a srcset is not
 *    kept after the read recovers.
 */
export async function getCommittedVariantsForRender(
	ref: VariantMediaRef,
): Promise<CommittedVariant[]> {
	let db: Kysely<Database>;
	try {
		db = await getDb();
	} catch {
		return [];
	}
	try {
		return await getCommittedVariants(db, ref);
	} catch (error) {
		capPageCacheUntil(Date.now() + VARIANT_READ_RETRY_MS);
		if (Date.now() - lastReadFailureWarning >= VARIANT_READ_RETRY_MS) {
			lastReadFailureWarning = Date.now();
			console.warn("[emdash] stored image sizes could not be read; serving originals:", error);
		}
		return [];
	}
}

/** How far a variant's shape may differ from its parent's and still be the same picture. */
const SAME_SHAPE_TOLERANCE = 0.02;

/**
 * The width the original is drawn at when upright, or undefined when unknown.
 *
 * The parent row holds the stored pixel frame. A phone photo taken upright is
 * stored on its side with an orientation flag, so its row says 4032x3024 while the
 * picture a browser draws is 3024 wide. The variants were generated upright, so a
 * variant's own shape says which of the parent's two sides is the width. Using the
 * raw width there would tell the browser the image is wider than it is, and an
 * image with no width attribute would be drawn larger than before.
 */
export function uprightParentWidth(variants: readonly CommittedVariant[]): number | undefined {
	const first = variants[0];
	if (!first?.parentWidth || !first.parentHeight || !first.width || !first.height) return undefined;
	const { parentWidth, parentHeight } = first;
	const shape = first.width / first.height;
	const close = (to: number) => Math.abs(shape - to) / to <= SAME_SHAPE_TOLERANCE;
	const asStored = close(parentWidth / parentHeight);
	const turned = close(parentHeight / parentWidth);
	if (asStored && turned) return Math.min(parentWidth, parentHeight);
	if (asStored) return parentWidth;
	if (turned) return parentHeight;
	return undefined;
}

/** The storage key a content reference names, or null. */
function keyOfRef(ref: VariantMediaRef): string | null {
	if (ref.storageKey) return ref.storageKey;
	const fromUrl = storageKeyOf(ref.url ?? null);
	if (!fromUrl) return null;
	try {
		return decodeURIComponent(fromUrl);
	} catch {
		return null;
	}
}

/**
 * The `srcset` for an image a page is drawing, or null when nothing stored can
 * improve on the original.
 *
 * `ref` is what the CONTENT holds (a storage key, or the internal file url), never
 * the rendered `src`: with a public bucket configured the rendered `src` is a CDN
 * address that names no row. The candidates are always built on the internal file
 * route, because it is the only route that resolves `?w=`; a `?w=` appended to any
 * other address would be a promise nothing keeps.
 *
 * `drawnWidth` is the width the caller draws the image at. Without one the bound is
 * the original's upright width, and with neither nothing is offered, since `sizes`
 * would have to guess and could draw a small image larger than it is.
 */
export async function storedSizesForRender(
	ref: VariantMediaRef,
	drawnWidth?: number,
): Promise<{ srcset: string; bound: number } | null> {
	const key = keyOfRef(ref);
	if (!key) return null;
	const committed = await getCommittedVariantsForRender({ storageKey: key });
	const bound = drawnWidth ?? uprightParentWidth(committed);
	if (!bound) return null;
	const widths = srcsetWidthsFor(committed, bound);
	if (!widths.length) return null;
	const parentUrl = localMediaFileUrl(key);
	return { srcset: widths.map((w) => `${variantUrl(parentUrl, w)} ${w}w`).join(", "), bound };
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
 * `variants` and which is drawn `drawnWidth` CSS pixels wide.
 *
 * EMPTY when there is nothing to offer. Empty is the contract that keeps the markup
 * identical to a site with no variants, so it is a correct answer and not a failure.
 *
 * WHAT BOUNDS THE LIST IS A BYTE BUDGET, not the drawn width. `drawnWidth` is
 * often a display width far below the original's: a block resized to 640 needs the
 * 768 file on an ordinary screen and a file near 1280 on a dense one. Offering only
 * widths below 640 would draw that image from a 480 file, softer than the original
 * it replaced. So the list runs up to and including the first width that covers
 * twice the drawn width, and stops there: a deliberate 2x budget. A candidate
 * changes which file is fetched and never the layout, which the caller's width and
 * height attributes or its `sizes` bound already fix.
 */
export function srcsetWidthsFor(
	variants: readonly StoredVariant[],
	drawnWidth: number | undefined,
): number[] {
	if (!drawnWidth || drawnWidth <= 0) return [];
	const stored = [...new Set(variants.map((v) => v.width))]
		.filter((w) => Number.isInteger(w) && w > 0)
		.toSorted((x, y) => x - y);
	const widths: number[] = [];
	for (const w of stored) {
		widths.push(w);
		if (w >= drawnWidth * 2) break;
	}
	return widths;
}

/**
 * Every path that changes variant rows must call this, or a warm page keeps
 * serving a srcset for variants that no longer exist.
 */
export function invalidateVariants(): void {
	invalidateObjectCache(CacheNamespace.MEDIA_VARIANTS);
}
