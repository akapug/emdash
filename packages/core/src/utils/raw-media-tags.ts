/**
 * Give the stored image sizes to media `<img>` tags that came through raw HTML.
 *
 * WHY THIS EXISTS. `HtmlBlock.astro:31` renders `set:html={sanitized}` — the sanitised string, untouched.
 * A WordPress body that carried `<img class="alignleft" src="/_emdash/api/media/file/KEY.jpg" width="300"
 * height="225">` therefore reaches the browser with no srcset, drawn at full size. MEASURED on rehearsal af:
 * that one tag fetches 874 KB to fill a 300x225 box, while the tenant holds four stored sizes for it —
 * including a 300x225. No component draws it, so no component could offer them.
 *
 * WHAT IT DOES NOT DO. It is not a sanitiser and it must not become one: the string it returns has already
 * been through `sanitizeContent`, and every attribute it does not deliberately change is passed through byte
 * for byte. It only ADDS `srcset` and `sizes` to a tag whose `src` is a media-file URL, and leaves the tag
 * exactly as it was when the tenant holds nothing to offer.
 */
import { storedSizesForRender } from "../media/variant-read.js";

/** The one URL shape this touches: our own media-file route, which carries a storage key. */
const MEDIA_FILE = /\/_emdash\/api\/media\/file\/([^"'\s>]+)/;

/** An `<img …>` tag, whole. */
const IMG_TAG = /<img\b[^>]*>/gi;

/**
 * Return `html` with `srcset` and `sizes` added to each media-file `<img>` that has stored sizes.
 *
 * The width to bound by, in order: the tag's OWN `width`, because WordPress writes it and a 300-wide tag
 * wants the 300 rung; then the parent row's upright width, which the lookup returns; then nothing, in which
 * case the tag is left alone rather than guessed at.
 */
export async function withStoredSizes(html: string): Promise<string> {
	if (!html.includes("/_emdash/api/media/file/")) return html;
	const tags = [...html.matchAll(IMG_TAG)];
	if (tags.length === 0) return html;

	const replacements = new Map<string, string>();
	for (const match of tags) {
		const tag = match[0];
		// A tag that already offers sizes is somebody else's work — never rewrite it.
		if (/\bsrcset\s*=/i.test(tag)) continue;
		const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
		const key = src ? MEDIA_FILE.exec(src)?.[1] : undefined;
		if (!key) continue;
		const ownWidth = Number(/\bwidth\s*=\s*"(\d+)"/i.exec(tag)?.[1]);
		const sized = await storedSizesForRender(
			{ storageKey: safeDecode(key) },
			Number.isInteger(ownWidth) && ownWidth > 0 ? ownWidth : undefined,
		);
		if (!sized) continue;
		// SIZES FROM THE SAME BOUND the srcset was built against: a srcset without it makes the browser
		// assume 100vw and take the largest rung, which is the thing this is fixing.
		replacements.set(tag, addAttributes(tag, { srcset: sized.srcset, sizes: `(min-width: ${sized.bound}px) ${sized.bound}px, 100vw` }));
	}

	if (replacements.size === 0) return html;
	// One pass, by whole tag text: an `<img>` string appears at most once in practice, and replacing by
	// tag avoids re-parsing the document or disturbing the whitespace between elements.
	let out = html;
	for (const [tag, withSizes] of replacements) out = out.replace(tag, withSizes);
	return out;
}

/** Insert attributes before the tag's closing `>`, keeping everything already there. */
function addAttributes(tag: string, extra: Record<string, string>): string {
	const additions = Object.entries(extra)
		.map(([name, value]) => ` ${name}="${value.replaceAll('"', "&quot;")}"`)
		.join("");
	return tag.replace(/\s*\/?>$/, (end) => `${additions}${end.startsWith("/") ? "/>" : ">"}`);
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
