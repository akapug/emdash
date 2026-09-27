/**
 * URL scheme validation for the converter pipeline (defense-in-depth).
 *
 * This mirrors the canonical sanitizeHref in packages/core/src/utils/url.ts.
 * The converter is a standalone zero-dependency package, so it carries its own
 * copy. The render layer in core is the primary defense; this is secondary.
 */

const SAFE_URL_SCHEME_RE = /^(https?:|mailto:|tel:|\/(?!\/)|#)/i;

/**
 * Returns the URL if it uses a safe scheme, otherwise returns "".
 *
 * The white space around it goes first, as a browser takes it off an `href`
 * before it follows the link: WordPress draws `<a href=" https://…">` as a
 * working link, and read as written it failed the scheme check (a text link
 * to nowhere, an image with its link gone).
 *
 * Returns empty string (not "#") because this is the converter layer — we
 * strip bad URLs rather than substituting anchors. The render layer handles
 * the fallback to "#".
 */
export function sanitizeHref(url: string | undefined | null): string {
	const href = url?.trim();
	if (!href) return "";
	return SAFE_URL_SCHEME_RE.test(href) ? href : "";
}
