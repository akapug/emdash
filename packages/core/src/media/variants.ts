/**
 * Stored image variants — the resolver, the ladder, and the rules a variant
 * must satisfy before it may be stored or served.
 *
 * WHY THIS EXISTS. WordPress stored a handful of resized copies of every upload
 * (thumbnail/medium/large and friends). The importer carries the original only,
 * so every page asks a browser for full-size photographs: measured on one real
 * customer, an events page delivered 12.6 MB where the source delivered 159 KB.
 * Carrying the source's own generated sizes is the cure that needs no runtime
 * image service and no per-site vendor charge.
 *
 * THE RULE THAT SHAPES THE WHOLE FILE: **a variant is never addressed by its own
 * key.** The public URL is the PARENT's, with a width hint — `?w=768`. The route
 * resolves the best committed variant of the CURRENT parent at that width, and
 * otherwise streams the original. That single choice means:
 *
 *  - nothing is rewritten at import, so nothing has to be un-rewritten at
 *    rollback;
 *  - no variant key is ever public, so a half-written or since-withdrawn object
 *    cannot be fetched by anyone who guessed its name;
 *  - a replaced parent, a restored site without variants, or a retired row all
 *    degrade to the original by construction rather than by a guard.
 *
 * The width-hinted URL is MUTABLE BY NATURE. Its bytes change identity across a
 * replace or a rollback, so it must never be served `immutable` — see
 * {@link VARIANT_CACHE_CONTROL}.
 */

/** The widths a renderer may ask for. Fixed, so the srcset and the store agree. */
export const VARIANT_LADDER = [300, 480, 768, 1024] as const;

/**
 * Cache policy for a width-hinted parent URL.
 *
 * NOT `IMMUTABLE_IMAGE_CACHE`. That policy is correct for content-addressed
 * URLs, and a `?w=` URL is the opposite: the variant behind it can be retired,
 * replaced, or rolled back. An immutable header would leave a rolled-back
 * variant in a browser for a year — the one failure this design must not have.
 * This is the same policy the media file route already uses for images that
 * Replace may overwrite (`MUTABLE_MEDIA_CACHE_CONTROL`).
 */
export const VARIANT_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/**
 * How far a variant's aspect ratio may differ from its parent's before it stops
 * being a smaller version of that image and becomes a different crop.
 *
 * One percent. A 300x300 hard crop of a 4414x6122 portrait is a 33% difference
 * and must never be offered as a smaller version of it — a browser choosing it
 * from a srcset would see the photograph destroyed. Crops stay crops, done in
 * CSS with `object-fit`, exactly as they are today.
 */
export const ASPECT_TOLERANCE = 0.01;

/** The raster types a variant may be. Order matters only for reporting. */
export const RASTER_TYPES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
] as const;

/** A variant as the database holds it. */
export interface StoredVariant {
	/** The parent media row this is a size of. */
	mediaId: string;
	/** WordPress's own name for the size, kept for provenance only. Never trusted for a check. */
	sizeName: string;
	width: number;
	height: number;
	/** The object key. Never public: nothing routes to it directly. */
	storageKey: string;
	bytes: number;
	/** sha256 of the stored bytes — the identity that makes a duplicate a replay and a mismatch a conflict. */
	contentHash: string;
	/**
	 * The parent's CONTENT HASH when this was committed.
	 *
	 * `media` has no generation column — MEASURED from its schema — so this is the
	 * identity that actually changes when an image is replaced: Replace rewrites
	 * `content_hash`. A variant whose hash differs from the parent's belongs to
	 * bytes that no longer exist, so it is invisible without anyone sweeping it.
	 */
	parentContentHash: string;
	createdAt: string;
}

/** Why a variant offer was refused. Each names the rule, not a code. */
export type VariantRefusal =
	| "not-a-raster"
	| "dimensions-do-not-match-bytes"
	| "not-smaller-than-the-parent"
	| "aspect-differs-from-the-parent"
	| "not-on-the-ladder"
	| "over-the-byte-cap";

/** The parent facts a variant is checked against. */
export interface VariantParent {
	id: string;
	width: number;
	height: number;
	/** The parent row's current `content_hash`. */
	contentHash: string | null;
	status: string;
}

/** The bytes-derived facts of an offer, supplied by the caller after decoding. */
export interface VariantOffer {
	sizeName: string;
	width: number;
	height: number;
	/** Dimensions read from the encoded bytes — NOT from the client's claim. */
	decodedWidth: number;
	decodedHeight: number;
	contentType: string;
	bytes: number;
}

/** The most a single variant object may be. Every real size measured is 30-142 KB. */
export const VARIANT_BYTE_CAP = 2 * 1024 * 1024;

/**
 * Every rule a variant must satisfy, in the order that gives the most useful
 * refusal. Returns the first rule broken, or `null` when the offer is good.
 *
 * These are enforced **server-side on the route**, not only here: a client that
 * skips this function must still be refused. Keeping the rules in one exported
 * function is what lets the route and its arms share them without duplicating
 * the numbers.
 */
export function variantRefusal(parent: VariantParent, offer: VariantOffer): VariantRefusal | null {
	if (!(RASTER_TYPES as readonly string[]).includes(offer.contentType)) return "not-a-raster";
	if (offer.bytes > VARIANT_BYTE_CAP) return "over-the-byte-cap";
	// The client's claim is irrelevant; the bytes decide.
	if (offer.decodedWidth !== offer.width || offer.decodedHeight !== offer.height)
		return "dimensions-do-not-match-bytes";
	if (!(VARIANT_LADDER as readonly number[]).includes(offer.width)) return "not-on-the-ladder";
	if (offer.width >= parent.width && offer.height >= parent.height)
		return "not-smaller-than-the-parent";
	if (parent.width <= 0 || parent.height <= 0 || offer.height <= 0)
		return "aspect-differs-from-the-parent";
	const parentRatio = parent.width / parent.height;
	const offerRatio = offer.width / offer.height;
	if (Math.abs(offerRatio - parentRatio) / parentRatio > ASPECT_TOLERANCE)
		return "aspect-differs-from-the-parent";
	return null;
}

/**
 * The variant a `?w=` request should receive: the smallest committed variant of
 * the CURRENT parent at width >= the hint, among those matching the parent's
 * aspect. `null` means "stream the original" — which is a correct answer, not a
 * failure.
 *
 * Two rules are load-bearing and each has an arm:
 *  - a variant from an older parent generation is invisible here, so a replaced
 *    parent stops serving the variants of the image it used to be;
 *  - the parent must be `ready`, so a draft or a deleted parent does not serve
 *    through a path that skips the asset view's own eligibility check.
 */
export function chooseVariant(
	parent: VariantParent | null,
	variants: readonly StoredVariant[],
	hintWidth: number | null,
): StoredVariant | null {
	if (!parent || parent.status !== "ready") return null;
	// A hint that is not a positive integer is not a width request.
	if (hintWidth === null || !Number.isInteger(hintWidth) || hintWidth <= 0) return null;
	const parentRatio = parent.width > 0 && parent.height > 0 ? parent.width / parent.height : null;
	const eligible = variants.filter(
		(v) =>
			v.mediaId === parent.id &&
			parent.contentHash !== null &&
			v.parentContentHash === parent.contentHash &&
			v.width >= hintWidth &&
			v.width < parent.width &&
			parentRatio !== null &&
			Math.abs(v.width / v.height - parentRatio) / parentRatio <= ASPECT_TOLERANCE,
	);
	if (!eligible.length) return null;
	// The smallest width that still satisfies the hint: the fewest bytes a browser
	// can use without going below what it asked for.
	return eligible.reduce((best, v) => (v.width < best.width ? v : best));
}

/**
 * The `srcset` widths for a parent image of `width`, taken from the ladder and
 * never including the original at a smaller descriptor.
 *
 * The defect this replaces: the cover/card path emitted a ten-entry srcset in
 * which every entry was the SAME url, so a browser downloaded the original at
 * whatever descriptor it picked. A descriptor that maps to the original is not a
 * smaller image, and offering it is worse than offering nothing.
 */
export function variantSrcsetWidths(width: number | undefined): number[] {
	if (!width || width <= 0) return [];
	const below = VARIANT_LADDER.filter((w) => w < width);
	return below.length ? [...below] : [];
}

/**
 * The URL a renderer emits for one width: the parent's own URL, with the width
 * hint. There is deliberately no function that builds a variant's URL — that is
 * the design, not an omission.
 */
export function variantUrl(parentUrl: string, width: number): string {
	const url = new URL(parentUrl, "https://placeholder.invalid");
	url.searchParams.set("w", String(width));
	// Return a path when the input was a path, so the markup stays same-origin.
	const path = `${url.pathname}${url.search}`;
	return parentUrl.startsWith("/") ? path : url.href;
}
