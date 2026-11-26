/**
 * THE WIDTHS A MEDIA VARIANT MAY BE STORED AT, and the capability that says a build supports them.
 *
 * 161: WordPress generates sizes at its own widths — 150/265/390/524/600/672/1038 on real sites — and a fixed six-rung ladder
 * refused 44–88% of them. The variant route has always resolved `?w=N` by an EXACT stored width with no ladder, so carrying the
 * source's numbers needed a NAME for the fact (so a host can tell an old tenant from a new one) and a BOUND, not a rewrite.
 *
 * THIS MODULE EXISTS SO A MEDIA MODULE DOES NOT IMPORT A ROUTE MODULE. The constants first lived in
 * `astro/routes/api/import/wordpress/analyze.ts`, and `media/variant-serve.ts` imported them from there — which drags an Astro
 * route (and its `declare global { namespace App { interface Locals } }`) into every program that touches media, and made
 * `Locals` resolve differently in the typecheck. Shared constants belong beside the thing they describe.
 */

/**
 * A build advertising this stores a variant at any integer width in range, not only on a ladder.
 *
 * A host sends off-ladder widths ONLY to a tenant that advertises it; every other tenant keeps today's ladder, so agreeing to
 * disagree produces no new refusals.
 */
export const MEDIA_VARIANTS_ANY_WIDTH_CAPABILITY = "emdash.media-variants.any-width.v1" as const;

/**
 * The range a variant width may fall in.
 *
 * The floor is 1 rather than a real minimum because the range is a guard against nonsense reaching a query, not a policy: a
 * 100px thumbnail is a legitimate size for a logo. The ceiling is 4096, comfortably past the widest generated size measured
 * (2048) and the widest original a WordPress site serves as a variant.
 */
export const VARIANT_MIN_WIDTH = 1;
export const VARIANT_MAX_WIDTH = 4096;
