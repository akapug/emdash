/**
 * The text alignment WordPress gave a block, as EmDash stores it: `textAlign`
 * on a Portable Text text block, one of `center`, `right` or `justify`. Left
 * is the default and is never stored (see `prosemirrorToPortableText` in
 * packages/core); the renderer draws the value as WordPress's own
 * `has-text-align-{value}` class (packages/core/src/components/Block.astro).
 *
 * WordPress writes it two ways that hold whatever the theme's CSS says:
 *
 *   - the classic editor, inline: `<p style="text-align: center;">`;
 *   - the block editor, as a class in the saved markup
 *     (`<p class="has-text-align-center">`), with the same value in the
 *     block's attributes: `align` on a paragraph, `textAlign` on a heading,
 *     `style.typography.textAlign` in newer releases.
 *
 * Inline style wins over a class, as it does in the browser, and the last
 * `text-align` declaration wins over an earlier one. An explicit `left` is
 * the default, so it is not stored either.
 *
 * Old HTML's `<p align="center">` is NOT read. It is a presentational hint,
 * which any author rule for `text-align` overrides, and themes set one:
 * Twenty Twenty's reset gives every `p` and heading `text-align: inherit`,
 * so WordPress draws those paragraphs left-aligned (measured on a migrated
 * site's history page). Stored, it would become a class that beats the
 * theme, and centre what WordPress never centred.
 */

import { attrObject, attrString } from "./types.js";

export type TextAlign = "center" | "right" | "justify";

const OPEN_TAG = /^\s*<[a-z][a-z0-9]*\b([^>]*)>/i;
const STYLE_ATTR = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const CLASS_ATTR = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const TEXT_ALIGN_DECLARATION = /(?:^|;)\s*text-align\s*:\s*([a-z]+)\s*(?:!important\s*)?(?=;|$)/gi;
const ALIGN_CLASS = /(?:^|\s)has-text-align-([a-z]+)(?=\s|$)/i;

/** A WordPress alignment word: `left` is kept here so it can override, and dropped at the end. */
function alignment(value: string | undefined): TextAlign | "left" | undefined {
	switch (value?.trim().toLowerCase()) {
		case "center":
			return "center";
		case "right":
			return "right";
		case "justify":
			return "justify";
		case "left":
			return "left";
		default:
			return undefined;
	}
}

const stored = (a: TextAlign | "left" | undefined): TextAlign | undefined => (a === "left" ? undefined : a);

/** The alignment the opening tag of `html` gives its element, read the way a browser reads it. */
export function textAlignOfTag(html: string): TextAlign | undefined {
	const attrs = OPEN_TAG.exec(html)?.[1];
	if (!attrs) return undefined;
	const style = STYLE_ATTR.exec(attrs);
	if (style) {
		let last: TextAlign | "left" | undefined;
		for (const m of (style[1] ?? style[2] ?? "").matchAll(TEXT_ALIGN_DECLARATION)) {
			last = alignment(m[1]) ?? last;
		}
		if (last) return stored(last);
	}
	const cls = CLASS_ATTR.exec(attrs);
	return stored(alignment(ALIGN_CLASS.exec(cls?.[1] ?? cls?.[2] ?? "")?.[1]));
}

/** The alignment a paragraph or heading block's attributes name, in any of the spellings WordPress used. */
export function textAlignOfAttrs(attrs: Record<string, unknown>): TextAlign | undefined {
	const typography = attrObject(attrObject(attrs, "style") ?? {}, "typography") ?? {};
	for (const v of [attrString(attrs, "textAlign"), attrString(typography, "textAlign"), attrString(attrs, "align")]) {
		const a = alignment(v);
		if (a) return stored(a);
	}
	return undefined;
}
