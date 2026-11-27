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
import { constrainedSizes } from "../media/responsive.js";
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
/**
 * The source `<img>`'s own `sizes` attribute, decoded, or null when it states none.
 *
 * AN UNQUOTED VALUE IS NEVER TRUSTED, and a QUOTED one is taken only when the attribute ends where the quote does. A tag whose
 * `sizes` value is followed by more attribute text inside the same quotes (`sizes="400px" onerror="alert(1)"`) is refused whole:
 * that shape means the source's markup was already broken, and passing any of it through would carry the rest with it.
 */
function sizesOf(tag: string): string | null {
	const m = SIZES_ATTRIBUTE.exec(tag);
	if (!m) return null;
	const v = (m[1] ?? m[2] ?? "").trim();
	if (v === "") return null;
	// Anything attribute-like inside the value means the quote was closed by something else; refuse rather than guess.
	if (ATTRIBUTE_INSIDE_VALUE.test(v)) return null;
	return v;
}

/**
 * Whether a `sizes` value is inside the CSS grammar a browser accepts, so a source cannot put anything else in the markup.
 *
 * Allowed: media conditions of the shape `(min-width: 400px)` / `(max-width: 767px)` / `(orientation: landscape)`, and a length in
 * px/em/rem/vw/vh/%/pt/vmin/vmax/cm/mm/in/pc, or `auto`, or a bare `calc(...)` with no quotes or angle brackets. Commas separate
 * entries. NOTHING ELSE — no quotes, no `<>`, no backslashes, no url(), no CSS comment opener — so a value that could break out of the
 * attribute or reach a stylesheet is refused and rule 2 applies instead.
 *
 * This is a grammar check, not a sanitiser: it refuses rather than repairs, which is what the ruling asks for.
 */
function isSizesGrammar(value: string): boolean {
	if (value.length > 512) return false;
	// Anything that could terminate or re-open the attribute, or start a CSS comment / escape, is out before parsing.
	if (FORBIDDEN_IN_SIZES.test(value)) return false;
	const entries = value.split(",");
	if (entries.length === 0 || entries.length > 16) return false;
	for (const raw of entries) {
		const entry = raw.trim();
		if (entry === "") return false;
		// Split off leading media conditions; what remains must be a length, `auto`, or a plain calc().
		let rest = entry;
		while (SIZES_MEDIA_CONDITION.test(rest)) rest = rest.replace(SIZES_MEDIA_CONDITION, "").trim();
		if (rest === "auto" || SIZES_LENGTH.test(rest)) continue;
		if (SIZES_CALC.test(rest) && SIZES_CALC_BODY.test(rest.replace(SIZES_CALC_PREFIX, ""))) continue;
		return false;
	}
	return true;
}

export async function withStoredSizes(
	html: string,
	opts: {
		/** The site's PUBLIC origin. Without it only a root-relative src is recognised as ours. */
		origin?: string;
		/** Injected so the rewrite's contract can be tested; the render path gets the real read. */
		lookup?: Lookup;
		/** The content column's inner width in CSS px, measured from the layout (141c). Caps the slot when the source states none. */
		slotMaxWidth?: number | undefined;
		/** Horizontal padding around that column on narrow viewports. */
		gutterPx?: number | undefined;
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
			const ownWidth = WHOLE_NUMBER.test(attributes.get("width")?.trim() ?? "")
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
			// SIZES, in the order item 164g rules:
			//
			// 1. THE SOURCE'S OWN `sizes` WINS. Source behaviour is the spec, and the source is the only thing that knows the
			//    column: adamkoren's podcast cover is 2560 wide and its page says `(max-width: 767px) 100vw, 400px`, because
			//    Avada lays it out in a 400px author-chosen image_size. We cannot re-derive that, and `result.bound` — the
			//    file's own width — is the worst guess available: measured, it made the /about/ page 3.47x live's weight.
			//    A value outside the CSS `sizes` grammar is DROPPED and rule 2 applies, so a hostile string cannot reach the
			//    markup.
			// 2. Otherwise a SLOT capped by the content column, never the file's width alone.
			const declared = sizesOf(match[0]);
			const sizes = declared !== null && isSizesGrammar(declared)
				? declared
				: constrainedSizes(result.bound, opts.slotMaxWidth, opts.gutterPx ?? 0);
			// REPLACE, never append: `addAttributes` writes a second attribute of the same name, so a source `sizes` that was
			// REFUSED stayed on the tag beside ours — measured: the output carried both the hostile value and the capped one.
			return addAttributes(withoutSizes(match[0]), { srcset: result.srcset, sizes });
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

/** A whole number, as a width attribute holds it. */
const WHOLE_NUMBER = /^\d+$/;

/** A decimal, hexadecimal or named character reference. */
const CHARACTER_REFERENCE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;

/** The end of a tag: `>` or `/>`, with any whitespace before it. */
const TAG_END = /(\s*\/?>)$/;
/** The source tag's own `sizes` attribute, quoted only. Module scope so the pattern is compiled once: it is read for every image. */
const SIZES_ATTRIBUTE = /\ssizes\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
/** Anything attribute-like inside a `sizes` value: the quote was closed by something else, so the value is refused whole. */
const ATTRIBUTE_INSIDE_VALUE = /\s[a-z-]+\s*=/iu;
/** Anything that could terminate or re-open the attribute, or start a CSS comment / escape. */
const FORBIDDEN_IN_SIZES = /["'<>\\]|\/\*|url\s*\(/iu;
/** A media condition inside `sizes`: `(min-width: 400px)`, `(orientation: landscape)`. */
const SIZES_MEDIA_CONDITION = /\(\s*[a-z-]+\s*:\s*[a-z0-9.%\s-]+\s*\)/iu;
/** A CSS length: `400px`, `50vw`, `1.5rem`. */
const SIZES_LENGTH = /^(?:\d*\.?\d+)(?:px|em|rem|vw|vh|vmin|vmax|%|pt|cm|mm|in|pc)$/iu;
/** A plain `calc(...)` with no nested parentheses. */
const SIZES_CALC = /^calc\([^()]*\)$/iu;
/** The `calc` keyword itself, stripped before the body is checked. */
const SIZES_CALC_PREFIX = /^calc/iu;
/** The inside of a `calc(...)`: digits, spaces, arithmetic and letters only. */
const SIZES_CALC_BODY = /^[\d\s.+\-*/()a-z%]+$/iu;
/** A `sizes` attribute on an `<img>`, quoted or not — what `withoutSizes` removes. */
const SIZES_ATTRIBUTE_ANY = /\ssizes\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/iu;

/** Decode the character references a serialiser writes in an attribute value; any other is kept as written. */
function decodeReferences(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(CHARACTER_REFERENCE, (whole, dec?: string, hex?: string, name?: string) => {
		if (name) return NAMED[name.toLowerCase()] ?? whole;
		const code = dec ? Number(dec) : Number.parseInt(hex!, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

/** Insert attributes before the tag's closing `>` or `/>`, keeping everything already there. */
/** The tag with `name` removed, so a rewritten attribute replaces the source's instead of standing beside it. */
function withoutSizes(tag: string): string {
	return tag.replace(SIZES_ATTRIBUTE_ANY, "");
}

function addAttributes(tag: string, extra: Record<string, string>): string {
	const additions = Object.entries(extra)
		.map(
			([name, value]) => ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`,
		)
		.join("");
	return tag.replace(TAG_END, (end) => `${additions}${end}`);
}
