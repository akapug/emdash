/**
 * The text alignment WordPress gave a block, as EmDash stores it: `textAlign`
 * on a Portable Text text block, one of `left`, `center`, `right` or
 * `justify`. The renderer draws center, right and justify as WordPress's own
 * `has-text-align-{value}` class (packages/core/src/components/Block.astro);
 * left is its default, and it draws no class for it.
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
 * `text-align` declaration wins over an earlier one.
 *
 * AN EXPLICIT `left` IS STORED. Left is the default only where the theme's
 * CSS does not align the region: Franz Josef centres its front page's
 * highlights (`.highlights { text-align: center }`), and the classic editor's
 * `<p style="text-align: left;">` is what keeps that page's paragraphs left.
 * A layout that draws WordPress's own design (the blog template's WpShell)
 * draws the stored left; nothing is stored for a block WordPress gave no
 * alignment.
 *
 * Old HTML's `<p align="center">` is NOT read. It is a presentational hint,
 * which any author rule for `text-align` overrides, and themes set one:
 * Twenty Twenty's reset gives every `p` and heading `text-align: inherit`,
 * so WordPress draws those paragraphs left-aligned (measured on a migrated
 * site's history page). Stored, it would become a class that beats the
 * theme, and centre what WordPress never centred.
 */

import { attrObject, attrString } from "./types.js";

export type TextAlign = "left" | "center" | "right" | "justify";

const OPEN_TAG = /^\s*<[a-z][a-z0-9]*\b([^>]*)>/i;
const STYLE_ATTR = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const CLASS_ATTR = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const TEXT_ALIGN_DECLARATION = /(?:^|;)\s*text-align\s*:\s*([a-z]+)\s*(?:!important\s*)?(?=;|$)/gi;
const ALIGN_CLASS = /(?:^|\s)has-text-align-([a-z]+)(?=\s|$)/i;

/** A WordPress alignment word. */
function alignment(value: string | undefined): TextAlign | undefined {
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

/** The alignment the opening tag of `html` gives its element, read the way a browser reads it. */
export function textAlignOfTag(html: string): TextAlign | undefined {
	const attrs = OPEN_TAG.exec(html)?.[1];
	if (!attrs) return undefined;
	const style = STYLE_ATTR.exec(attrs);
	if (style) {
		let last: TextAlign | undefined;
		for (const m of (style[1] ?? style[2] ?? "").matchAll(TEXT_ALIGN_DECLARATION)) {
			last = alignment(m[1]) ?? last;
		}
		if (last) return last;
	}
	const cls = CLASS_ATTR.exec(attrs);
	return alignment(ALIGN_CLASS.exec(cls?.[1] ?? cls?.[2] ?? "")?.[1]);
}

/** The alignment a paragraph or heading block's attributes name, in any of the spellings WordPress used. */
export function textAlignOfAttrs(attrs: Record<string, unknown>): TextAlign | undefined {
	const typography = attrObject(attrObject(attrs, "style") ?? {}, "typography") ?? {};
	for (const v of [
		attrString(attrs, "textAlign"),
		attrString(typography, "textAlign"),
		attrString(attrs, "align"),
	]) {
		const a = alignment(v);
		if (a) return a;
	}
	return undefined;
}
