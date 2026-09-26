/**
 * Text alignment survives the conversion: a paragraph WordPress centred is a
 * Portable Text block with `textAlign: "center"`, which is how EmDash stores
 * it (the editor reads it, and the renderer draws `has-text-align-center`).
 * Before, every block came out left-aligned, whichever way WordPress wrote it.
 */

import { describe, expect, it } from "vitest";

import { textAlignOfAttrs, textAlignOfTag } from "../src/align.js";
import { gutenbergToPortableText, htmlToPortableText } from "../src/index.js";
import type { PortableTextBlock } from "../src/types.js";

const aligns = (blocks: PortableTextBlock[]) =>
	blocks.map((b) => (b._type === "block" ? (b.textAlign ?? "-") : b._type));

describe("text alignment: the classic editor", () => {
	it("carries text-align from a paragraph's style, and adds nothing to one without it", () => {
		const html = `<p style="text-align: center;"><strong>Centred words.</strong></p>
<p>Left words.</p>
<p style="text-align:right">Right words.</p>
<p style="color: red; text-align: justify">Justified words.</p>`;
		const blocks = htmlToPortableText(html);
		expect(aligns(blocks)).toEqual(["center", "-", "right", "justify"]);
		expect(Object.hasOwn(blocks[1]!, "textAlign")).toBe(false);
	});

	it("carries it on headings, blockquotes and a text div", () => {
		const html = `<h2 style="text-align: center;">A heading</h2>
<blockquote style="text-align: right;">A quote</blockquote>
<div style="text-align: center;">Words in a div</div>`;
		expect(aligns(htmlToPortableText(html))).toEqual(["center", "right", "center"]);
	});

	it("reads the block editor's class in classic content", () => {
		expect(aligns(htmlToPortableText(`<p class="has-text-align-right">Saved markup</p>`))).toEqual(["right"]);
	});

	it("leaves old HTML's align attribute to the theme, which may override it", () => {
		// Twenty Twenty's reset (`p { text-align: inherit }`) beats the hint, so
		// WordPress draws this left; a stored textAlign would centre it.
		const blocks = htmlToPortableText(`<p align="center">Old HTML</p><h2 align="center">Old heading</h2>`);
		expect(aligns(blocks)).toEqual(["-", "-"]);
		expect(textAlignOfTag(`<p align="center" style="text-align: right">`)).toBe("right");
	});

	it("reads it the way a browser does: inline style over class, the last declaration last", () => {
		expect(textAlignOfTag(`<p class="has-text-align-center" style="text-align: right">`)).toBe("right");
		expect(textAlignOfTag(`<p style="text-align: center; text-align: right;">`)).toBe("right");
		// an explicit left is the default, and wins over the class it overrides
		expect(textAlignOfTag(`<p class="has-text-align-center" style="text-align: left">`)).toBeUndefined();
		expect(textAlignOfTag(`<p style="text-align: center !important;">`)).toBe("center");
	});

	it("stores nothing it does not know, and nothing from another attribute", () => {
		expect(textAlignOfTag(`<p style="text-align: centre">`)).toBeUndefined();
		expect(textAlignOfTag(`<p style="text-align: start">`)).toBeUndefined();
		expect(textAlignOfTag(`<p data-style="text-align: center" data-align="right">`)).toBeUndefined();
		expect(textAlignOfTag(`<p title="text-align: center">`)).toBeUndefined();
		expect(textAlignOfTag(`<p class="has-text-align-toString">`)).toBeUndefined();
		expect(textAlignOfTag("plain text")).toBeUndefined();
	});

	it("keeps the alignment of the paragraph's text when an image is lifted out of it", () => {
		const html = `<p style="text-align: center;"><img src="https://example.org/a.jpg" alt="A"> Caption words.</p>`;
		const blocks = htmlToPortableText(html);
		expect(aligns(blocks)).toEqual(["image", "center"]);
	});
});

describe("text alignment: the block editor", () => {
	it("carries a paragraph's alignment from its saved markup", () => {
		const content = `<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">Centred</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>Plain</p>
<!-- /wp:paragraph -->`;
		expect(aligns(gutenbergToPortableText(content))).toEqual(["center", "-"]);
	});

	it("carries a heading's textAlign", () => {
		const content = `<!-- wp:heading {"textAlign":"right","level":3} -->
<h3 class="wp-block-heading has-text-align-right">Right</h3>
<!-- /wp:heading -->`;
		const [block] = gutenbergToPortableText(content);
		expect(block).toMatchObject({ _type: "block", style: "h3", textAlign: "right" });
	});

	it("falls back to the attributes, in every spelling WordPress used", () => {
		expect(textAlignOfAttrs({ align: "center" })).toBe("center");
		expect(textAlignOfAttrs({ textAlign: "justify" })).toBe("justify");
		expect(textAlignOfAttrs({ style: { typography: { textAlign: "right" } } })).toBe("right");
		// a heading's `align` is its block width in newer releases, not its text
		expect(textAlignOfAttrs({ align: "wide" })).toBeUndefined();
		expect(textAlignOfAttrs({ align: "left" })).toBeUndefined();
		expect(textAlignOfAttrs({ align: 3, style: "center" })).toBeUndefined();
	});

	it("draws a heading whose block is wide at the default alignment", () => {
		const content = `<!-- wp:heading {"align":"wide"} -->
<h2 class="wp-block-heading alignwide">Wide</h2>
<!-- /wp:heading -->`;
		const [block] = gutenbergToPortableText(content);
		expect(block).toMatchObject({ _type: "block", style: "h2" });
		expect(Object.hasOwn(block!, "textAlign")).toBe(false);
	});
});
