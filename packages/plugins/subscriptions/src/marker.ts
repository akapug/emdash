/**
 * THE SIGN-UP MARKER IN IMPORTED HTML.
 *
 * A migrated WordPress site's sign-up box was a shortcode (`[newsletter]`,
 * `[mc4wp_form]`, `[mailpoet_form]`). A WXR carries only the shortcode text,
 * so there is no form in the HTML to find. The importer writes
 * `<div data-embark-subscribe="1"></div>` where the shortcode stood, and this
 * is the one place that knows the marker's shape.
 *
 * The split keeps the text either side in its place: WordPress drew the box
 * mid-article, and source behaviour is the spec.
 */

/** The marker, exactly as the importer writes it. */
export const SUBSCRIBE_MARKER = /<div\s+data-embark-subscribe="1"\s*><\/div>/gi;

/** Whether the HTML carries a sign-up marker at all. */
export function hasSubscribeMarker(html: string): boolean {
	SUBSCRIBE_MARKER.lastIndex = 0;
	const found = SUBSCRIBE_MARKER.test(html);
	SUBSCRIBE_MARKER.lastIndex = 0;
	return found;
}

/**
 * The HTML split at each marker: `pieces.length - 1` sign-ups stood between
 * them. A string with no marker comes back as one piece, unchanged.
 */
export function splitAtSubscribeMarkers(html: string): string[] {
	SUBSCRIBE_MARKER.lastIndex = 0;
	return html.split(SUBSCRIBE_MARKER);
}
