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
import { MediaRepository } from "../database/repositories/media.js";
import { getDb } from "../loader.js";
import { localMediaFileUrl } from "../media/url.js";
import { variantSrcsetWidths, variantUrl, type StoredVariant } from "../media/variants.js";
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
	const storageKey = keyOfRef(ref);
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

/**
 * The media row's own pixel size, or null when the row is unknown or records none.
 *
 * A CARD HAS NO DIMENSIONS OF ITS OWN, and Astro's <Image> refuses a remote src without them — so the card path
 * cannot reach the stored-widths branch, and its picture stays the multi-megabyte original. This gives the caller the
 * row's dimensions WITHOUT changing the shared read above: `storedSizesForRender` is used by every component that
 * draws a variant and several arms pin the markup they get, so it stays exactly as it was.
 *
 * Request-cached: a listing of twenty cards naming the same attachment asks once.
 */
export async function storedDimensionsForRender(ref: VariantMediaRef): Promise<{ width: number; height: number } | null> {
	const key = keyOfRef(ref);
	if (!key) return null;
	return requestCached(`media-dimensions:${key}`, async () => {
		try {
			const db = await getDb();
			const row = await new MediaRepository(db).findByStorageKey(key);
			const width = Number(row?.width ?? 0);
			const height = Number(row?.height ?? 0);
			return width > 0 && height > 0 ? { width, height } : null;
		} catch {
			// No database, no row: the caller draws a plain <img>, which is the honest markup.
			return null;
		}
	});
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

/**
 * The storage key a content reference names, or null.
 *
 * AN ADDRESS IS OURS ONLY IF IT IS OURS. A url names a local image when it is a
 * root-relative path under the internal file route, or an absolute url on this
 * site's own public origin with that path. Anything else is another site's file,
 * whatever its path looks like: `https://elsewhere.example/_emdash/api/media/file/K`
 * holding a key that also exists here must not be given our srcset, because the
 * browser would then draw OUR photo in place of theirs. Finding the route's prefix
 * somewhere inside the string is not that test.
 */
function keyOfRef(ref: VariantMediaRef): string | null {
	if (ref.storageKey) return ref.storageKey;
	const url = ref.url;
	if (!url) return null;
	let pathname: string;
	if (url.startsWith("/") && !url.startsWith("//")) {
		pathname = url;
	} else {
		if (!ref.origin) return null;
		try {
			const parsed = new URL(url);
			if (parsed.origin !== new URL(ref.origin).origin) return null;
			pathname = parsed.pathname;
		} catch {
			return null;
		}
	}
	if (!pathname.startsWith(INTERNAL_PREFIX)) return null;
	const raw = pathname.slice(INTERNAL_PREFIX.length).split(URL_SUFFIX)[0];
	if (!raw) return null;
	try {
		return decodeURIComponent(raw);
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
 *
 * `offerOriginal` adds the original as the last candidate when the stored sizes fall
 * short (see originalCandidateWidth). Only a caller that KNOWS the slot the image
 * fills may ask for it; every other caller gets stored sizes only.
 */
export async function storedSizesForRender(
	ref: VariantMediaRef,
	drawnWidth?: number,
	{ offerOriginal = false }: StoredSizesOptions = {},
): Promise<{ srcset: string; bound: number; shape: number | undefined } | null> {
	const key = keyOfRef(ref);
	if (!key) return null;
	const committed = await getCommittedVariantsForRender({ storageKey: key });
	const bound = drawnWidth ?? uprightParentWidth(committed);
	if (!bound) return null;
	const widths = srcsetWidthsFor(committed, bound);
	if (!widths.length) return null;
	const parentUrl = localMediaFileUrl(key);
	// Width over height of the picture as it is drawn: a variant is generated upright.
	const first = committed[0];
	const shape = first && first.height > 0 ? first.width / first.height : undefined;
	const candidates = widths.map((w) => `${variantUrl(parentUrl, w)} ${w}w`);
	const original = offerOriginal ? originalCandidateWidth(committed, widths, bound) : undefined;
	if (original) candidates.push(`${parentUrl} ${original}w`);
	return {
		srcset: candidates.join(", "),
		bound,
		shape,
	};
}

/** What a caller tells storedSizesForRender about the slot it draws into. */
export interface StoredSizesOptions {
	/**
	 * True only when the caller knows how wide the image is drawn: a cover fills the
	 * viewport, and an image an editor gave a display width is drawn at that width.
	 * A caller whose `sizes` value is a guess must leave it unset.
	 */
	offerOriginal?: boolean;
}

/**
 * The widest original offered beside the stored sizes as a matter of course: the
 * width WordPress itself scales a large upload down to, so the largest file its
 * own markup ever names. A wider original is a camera file of several megabytes.
 */
export const ORIGINAL_CANDIDATE_MAX_WIDTH = 2560;

/**
 * The width to offer the ORIGINAL at, as the last candidate, or undefined.
 *
 * ONLY WHERE THE CALLER KNOWS THE SLOT. storedSizesForRender asks this only for a
 * caller that passed `offerOriginal`, and that is deliberate.
 *
 * Why the original is offered at all: a browser given a srcset chooses only from
 * it; `src` is no longer a candidate. A 1000 wide original has stored sizes up to
 * 768, so a full-width cover on a 1440 screen was drawn from the 768 file and
 * stretched, where the page without stored sizes drew the 1000 wide original.
 * Measured in a browser on an imported site.
 *
 * Why only there: most callers do not know how wide the image is drawn. A card or a
 * content image inside a column is drawn 150 to 356 px wide but declares a `sizes`
 * such as `(min-width: 6000px) 6000px, 100vw`, so a 1440 wide browser believes it
 * needs 1440 px, finds the stored sizes end at 768, and takes the original. Offered
 * on every surface, the original took a home page from 6.8 MB of images to 19.0 MB
 * and an events page from 0.75 MB to 11.5 MB; one card fetched a 9.5 MB camera file
 * where it had fetched a 102 KB one. So a caller whose `sizes` value is a guess
 * must not ask for the original: for it the 768 file, slightly soft, is the right
 * price. A cover (drawn at the viewport's width, so `100vw` is true) and an image an
 * editor gave a display width know their slot, and ask.
 *
 * Within those callers, when the stored sizes run out before the budget this file
 * keeps (`offered` ends below twice the drawn width) and the original is wider than
 * the last of them, the original joins the list at its TRUE upright width. That is
 * not the defect this file exists to prevent, which was the original under a
 * smaller descriptor. Past the budget (a 3x screen on an image drawn small) the list
 * still ends at a stored size.
 *
 * Two cases, because the original can be very large:
 *  - up to ORIGINAL_CANDIDATE_MAX_WIDTH it always joins;
 *  - wider than that it joins only when the stored set is missing a size it could
 *    hold (a size the store refused, or a site stored before the ladder grew).
 *    With the whole ladder stored, the top rung stands in for it.
 */
export function originalCandidateWidth(
	variants: readonly CommittedVariant[],
	offered: readonly number[],
	drawnWidth: number | undefined,
): number | undefined {
	const last = offered.at(-1);
	if (last === undefined || !drawnWidth || last >= drawnWidth * 2) return undefined;
	const upright = uprightParentWidth(variants);
	if (!upright || upright <= last) return undefined;
	if (upright <= ORIGINAL_CANDIDATE_MAX_WIDTH) return upright;
	const ceiling = variantSrcsetWidths(upright).at(-1);
	return ceiling !== undefined && last < ceiling ? upright : undefined;
}

/** What a caller has in hand. Any one of these is enough. */
export interface VariantMediaRef {
	/** The storage key, e.g. `2024/01/photo.jpg`. */
	storageKey?: string | null;
	/** A public url that holds a storage key, e.g. `/_emdash/api/media/file/<key>`. */
	url?: string | null;
	/**
	 * This site's public origin. A page render passes it so an absolute `url` on the
	 * site's own origin is recognised; without it only a root-relative path is.
	 */
	origin?: string | null;
}

const INTERNAL_PREFIX = "/_emdash/api/media/file/";
/** A url's query or fragment: neither is part of the key. */
const URL_SUFFIX = /[?#]/;

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
