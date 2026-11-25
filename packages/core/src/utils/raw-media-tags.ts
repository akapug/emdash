/**
 * Give the stored image sizes to media `<img>` tags that came through raw HTML.
 *
 * WHY THIS EXISTS. `HtmlBlock.astro` renders `set:html` from the sanitised string, so a WordPress body's
 * `<img class="alignleft" src="/_emdash/api/media/file/KEY.jpg" width="300" height="225">` would reach the
 * browser with no srcset, drawn at full size. MEASURED on one imported site: that tag fetched 874 KB into a 300x225
 * box while the tenant held four stored sizes for it, including a 300x225.
 *
 * WHAT IT DOES NOT DO. It is not a sanitiser and must not become one: the string has already been through
 * `sanitizeContent`, and every byte this function does not deliberately change is passed through unchanged.
 * It does not decide whose image a src names either: `storedSizesForRender` owns that decision (a path under
 * the media route, or an absolute url on this site's own origin), and this file hands it the src as written.
 *
 * NOTE FOR THE RECORD: it is the SANITISER, not this change, that drops `decoding="async"` from a tag.
 */
import { responsiveSizes } from "../media/responsive.js";
import { storedSizesForRender } from "../media/variant-read.js";
import { sanitizeContent } from "./sanitize.js";

/** A cheap first filter: no media route anywhere means no tag of ours. */
const MEDIA_PATH = "/_emdash/api/media/file/";

/**
 * An `<img …>` tag, whole. A quoted VALUE is consumed as a unit, so a `>` inside an alt does not end the tag
 * early. A quote is read as opening a value only right after `=`; a stray one anywhere else means the tag is
 * not one this can read, and it is left alone rather than matched across the rest of the document.
 */
const IMG_TAG = /<img\b(?:[^>"'=]|=\s*"[^"]*"|=\s*'[^']*'|=)*>/gi;

/** One attribute: a name, then an optional double-quoted, single-quoted or unquoted value. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

type Lookup = typeof storedSizesForRender;

const HAS_IMG = /<img\b/i;

/** Whether an imported HTML body block keeps an image with the given source after sanitizing. */
export function htmlBlockHasImage(html: string, matches: (src: string) => boolean): boolean {
	if (!HAS_IMG.test(html)) return false;
	for (const [tag] of sanitizeContent(html).matchAll(IMG_TAG)) {
		const src = attributesOf(tag).get("src");
		if (src && matches(src)) return true;
	}
	return false;
}

/**
 * Return `html` with `srcset` and `sizes` added to each `<img>` whose src the lookup recognises as this
 * site's stored image and has stored sizes for.
 *
 * The width to bound by: the tag's OWN `width`, because WordPress writes it and a 300-wide tag wants the 300
 * rung; without one the lookup falls back to the original's upright width, or offers nothing.
 */
export async function withStoredSizes(
	html: string,
	opts: {
		/** The site's PUBLIC origin. Without it only a root-relative src is recognised as ours. */
		origin?: string;
		/** Injected so the rewrite's contract can be tested; the render path gets the real read. */
		lookup?: Lookup;
	} = {},
): Promise<string> {
	const { origin } = opts;
	const lookup = opts.lookup ?? storedSizesForRender;
	if (!html.includes(MEDIA_PATH)) return html;

	// ONE READ PER DISTINCT (src, width): a body that repeats an image, or holds hundreds, asks once each.
	const asked = new Map<string, ReturnType<Lookup>>();
	const tags = [...html.matchAll(IMG_TAG)];
	const sized = await Promise.all(
		tags.map(async (match) => {
			const attributes = attributesOf(match[0]);
			// A tag that already offers sizes is somebody else's work: never rewrite it.
			if (attributes.has("srcset")) return null;
			const src = attributes.get("src");
			if (!src) return null;
			const ownWidth = /^\d+$/.test(attributes.get("width")?.trim() ?? "")
				? Number(attributes.get("width"))
				: 0;
			const width = ownWidth > 0 ? ownWidth : undefined;
			const id = `${width ?? ""} ${src}`;
			let pending = asked.get(id);
			if (!pending) {
				pending = lookup({ url: src, origin }, width);
				asked.set(id, pending);
			}
			const result = await pending;
			if (!result) return null;
			// SIZES FROM THE SAME BOUND the srcset was built against: without it the browser assumes 100vw
			// and takes the largest rung, which is the thing being fixed.
			return addAttributes(match[0], {
				srcset: result.srcset,
				sizes: responsiveSizes(result.bound),
			});
		}),
	);
	const byOffset = new Map<number, string>();
	for (const [at, replacement] of sized.entries()) {
		if (replacement) byOffset.set(tags[at].index, replacement);
	}
	if (byOffset.size === 0) return html;

	// BY OFFSET AND BY FUNCTION. A replacement STRING would expand `$&`, `$'`, `$\`` and `$1` found in the
	// tag's own attributes, and a replacement keyed by tag text would rewrite only the first of two identical tags.
	return html.replace(IMG_TAG, (tag: string, offset: number) => byOffset.get(offset) ?? tag);
}

/**
 * The tag's attributes, names lowercased, values with their character references decoded. The FIRST of a
 * repeated name wins, as it does in a browser. Reading whole attributes is what keeps `data-src` from being
 * read as `src`, and the word "srcset" inside an alt from being read as a srcset.
 */
export function attributesOf(tag: string): Map<string, string> {
	const attributes = new Map<string, string>();
	const end = tag.endsWith("/>") ? -2 : -1;
	for (const m of tag.slice(4, end).matchAll(ATTRIBUTE)) {
		const name = m[1].toLowerCase();
		if (!attributes.has(name)) attributes.set(name, decodeReferences(m[2] ?? m[3] ?? m[4] ?? ""));
	}
	return attributes;
}

const NAMED: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

/** Decode the character references a serialiser writes in an attribute value; any other is kept as written. */
function decodeReferences(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(
		/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
		(whole, dec?: string, hex?: string, name?: string) => {
			if (name) return NAMED[name.toLowerCase()] ?? whole;
			const code = dec ? Number(dec) : Number.parseInt(hex!, 16);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		},
	);
}

/** Insert attributes before the tag's closing `>` or `/>`, keeping everything already there. */
function addAttributes(tag: string, extra: Record<string, string>): string {
	const additions = Object.entries(extra)
		.map(
			([name, value]) => ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`,
		)
		.join("");
	return tag.replace(/(\s*\/?>)$/, (end) => `${additions}${end}`);
}
