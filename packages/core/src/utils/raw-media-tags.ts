/**
 * Give the stored image sizes to media `<img>` tags that came through raw HTML.
 *
 * WHY THIS EXISTS. `HtmlBlock.astro:31` renders `set:html={sanitized}` — the sanitised string, untouched — so a
 * WordPress body's `<img class="alignleft" src="/_emdash/api/media/file/KEY.jpg" width="300" height="225">`
 * reaches the browser with no srcset, drawn at full size. MEASURED on rehearsal af: that tag fetched 874 KB
 * into a 300x225 box while the tenant held four stored sizes for it, including a 300x225.
 *
 * WHAT IT DOES NOT DO. It is not a sanitiser and must not become one: the string has already been through
 * `sanitizeContent`, and every byte this function does not deliberately change is passed through unchanged.
 *
 * NOTE FOR THE RECORD: it is the SANITISER, not this change, that drops `decoding="async"` from a tag.
 */
import { storedSizesForRender } from "../media/variant-read.js";

/** Our own media-file route, as a PATH. Anything else is somebody else's file. */
const MEDIA_PATH_PREFIX = "/_emdash/api/media/file/";

/** An `<img …>` tag, whole. */
const IMG_TAG = /<img\b[^>]*>/gi;

/**
 * Return `html` with `srcset` and `sizes` added to each own-origin media-file `<img>` that has stored sizes.
 *
 * The width to bound by, in order: the tag's OWN `width`, because WordPress writes it and a 300-wide tag wants
 * the 300 rung; then the parent row's upright width, which the lookup returns; then nothing, in which case the
 * tag is left alone rather than guessed at.
 *
 * `origin` is the site's own origin. A src on ANOTHER origin is that site's file, and giving it a srcset that
 * points at OUR route would swap one picture for another — so only a path, or an absolute URL on this origin,
 * is ever touched.
 */
export async function withStoredSizes(
	html: string,
	opts: {
		/** The site's own origin. An absolute src on any other origin is somebody else's file. */
		origin?: string;
		/** INJECTED SO THE CONTRACT CAN BE TESTED. The render path passes nothing and gets the real read. */
		lookup?: typeof storedSizesForRender;
	} = {},
): Promise<string> {
	const origin = opts.origin;
	const lookup = opts.lookup ?? storedSizesForRender;
	if (!html.includes(MEDIA_PATH_PREFIX)) return html;

	// ONE PASS OVER THE HTML, by function. A string replacement would expand `$&`, `$1`, `` $` `` and `$'`
	// inside the tag's own attributes (an alt of "Save $' today" would corrupt the page), and it would also
	// rewrite only the FIRST of two identical tags.
	let index = 0;
	const tags = [...html.matchAll(IMG_TAG)];
	const sized = await Promise.all(
		tags.map(async (match) => {
			const tag = match[0];
			// A tag that already offers sizes is somebody else's work — never rewrite it.
			if (/\bsrcset\s*=/i.test(tag)) return null;
			const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
			const key = src ? mediaKeyOf(src, origin) : null;
			if (!key) return null;
			const ownWidth = Number(/\bwidth\s*=\s*"(\d+)"/i.exec(tag)?.[1]);
			const result = await lookup(
				{ storageKey: key },
				Number.isInteger(ownWidth) && ownWidth > 0 ? ownWidth : undefined,
			);
			if (!result) return null;
			// SIZES FROM THE SAME BOUND the srcset was built against: without it the browser assumes 100vw
			// and takes the largest rung, which is the thing being fixed.
			return addAttributes(tag, {
				srcset: result.srcset,
				sizes: `(min-width: ${result.bound}px) ${result.bound}px, 100vw`,
			});
		}),
	);
	const byIndex = new Map<number, string>();
	for (const [at, replacement] of sized.entries()) if (replacement) byIndex.set(tags[at]!.index ?? -1, replacement);
	if (byIndex.size === 0) return html;

	return html.replace(IMG_TAG, (tag, offset: number) => byIndex.get(offset) ?? tag);
}

/**
 * Is `src` on OUR origin, exactly?
 *
 * The check after the origin must be a path or nothing at all. `https://site.example.evil.test` merely
 * BEGINS with `https://site.example`, and would otherwise be treated as ours and given a srcset pointing at
 * our file route — a swapped picture, which is the failure this whole function must not cause.
 */
function isOnOrigin(src: string, origin: string): boolean {
	if (!src.startsWith(origin)) return false;
	const rest = src.slice(origin.length);
	return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}

/**
 * The storage key for a src we own, or null.
 *
 * A PATH under our media route is ours. An absolute URL is ours only when it is on `origin` — otherwise the
 * file belongs to another site and swapping in a srcset on our route would show a different picture. A query
 * string or fragment is cut, because the key is the path segment and `KEY.jpg?v=2` names no row.
 */
function mediaKeyOf(src: string, origin?: string): string | null {
	let path: string;
	if (src.startsWith(MEDIA_PATH_PREFIX)) {
		path = src;
	} else if (origin && isOnOrigin(src, origin)) {
		// `startsWith(origin)` ALONE MATCHES `https://site.example.evil.test` — that host merely BEGINS with
		// ours. The authority must end here: nothing but the path may follow.
		path = src.slice(origin.length);
		if (!path.startsWith(MEDIA_PATH_PREFIX)) return null;
	} else {
		return null;
	}
	const withoutQuery = path.slice(0, Math.min(...[path.indexOf("?"), path.indexOf("#")].filter((i) => i >= 0).concat([path.length])));
	const key = withoutQuery.slice(MEDIA_PATH_PREFIX.length);
	if (!key) return null;
	try {
		return decodeURIComponent(key);
	} catch {
		return key;
	}
}

/** Insert attributes before the tag's closing `>`, keeping everything already there — `/>` included. */
function addAttributes(tag: string, extra: Record<string, string>): string {
	const additions = Object.entries(extra)
		.map(([name, value]) => ` ${name}="${value.replaceAll('"', "&quot;")}"`)
		.join("");
	return tag.replace(/(\s*\/?>)$/, (end) => `${additions}${end}`);
}
