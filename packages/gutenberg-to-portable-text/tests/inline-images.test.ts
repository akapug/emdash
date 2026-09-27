/**
 * An image inside a heading, a list item or a quote is drawn by WordPress
 * where it stands in the text: the classic editor puts an image at the
 * cursor, and a heading's first image then stands above its words (centred,
 * it is a block of its own; floated, it floats beside what follows). The
 * block editor's inline image sits in a paragraph's, heading's, list item's
 * or quote's text the same way. A text block holds spans alone, so the image
 * is an image block of its own, in document order; before, the converter
 * read these elements' text alone and dropped every image in them.
 */

import { describe, expect, it } from "vitest";

import { gutenbergToPortableText, parseInlineContent } from "../src/index.js";
import { parseInlineSegments } from "../src/inline.js";
import type { PortableTextBlock, PortableTextTextBlock } from "../src/types.js";

/** Each text block as its style and text; an image block as its file, alignment, size and link. */
const shape = (blocks: PortableTextBlock[]) =>
	blocks.map((b) => {
		if (b._type === "block") {
			const style = b.listItem ? `${b.style}/${b.listItem}` : b.style;
			return `${style}: ${b.children.map((c) => c.text).join("")}`;
		}
		if (b._type === "image") {
			const size = `${b.displayWidth ?? "-"}x${b.displayHeight ?? "-"}`;
			const link = typeof b.link === "string" ? ` ${b.link}` : "";
			return `[image ${b.asset.url?.split("/").pop()} ${b.alignment ?? "-"} ${size}${link}]`;
		}
		return b._type;
	});

const counter = () => {
	let n = 0;
	return () => `k${++n}`;
};

describe("classic content: an image inside a heading or a list item", () => {
	// The classic editor's markup for a post's banner, a list item's picture and a
	// floated picture in an empty heading. WordPress draws the banner above the
	// heading's words, the list item's picture under its text inside the item, and
	// the floated one beside what follows; the headings draw no line of their own.
	const content = `<h4><b><img class="aligncenter wp-image-1 size-full" src="https://example.org/wp-content/uploads/banner.png" alt="" width="275" height="218" />A Partnership Between Example Groups</b></h4>
<p>Words about it.</p>
<ul>
<li><span style="font-weight: 400;">An item with a picture.</span>
<h5 style="color: #181e1f;"><img class="aligncenter wp-image-2 size-medium" src="https://example.org/wp-content/uploads/building-300x169.jpg" alt="" width="300" height="169" /></h5>
</li>
<li>Another item.</li>
</ul>
<h4 style="color: #181e1f;"><b><img class="size-medium wp-image-3 alignright" src="https://example.org/wp-content/uploads/speaker-300x200.jpg" alt="" width="300" height="200" /></b></h4>
<h5><b>Our Donors:</b></h5>`;

	it("keeps every image, in the order WordPress draws it, with its alignment and size", () => {
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"[image banner.png center 275x218]",
			"h4: A Partnership Between Example Groups",
			"normal: Words about it.",
			"normal/bullet: An item with a picture.",
			"[image building-300x169.jpg center 300x169]",
			"normal/bullet: Another item.",
			"[image speaker-300x200.jpg right 300x200]",
			"h5: Our Donors:",
		]);
	});

	it("keeps the heading's words a heading, with their marks", () => {
		const heading = gutenbergToPortableText(content)[1];
		expect(heading).toMatchObject({
			_type: "block",
			style: "h4",
			children: [{ text: "A Partnership Between Example Groups", marks: ["strong"] }],
		});
	});

	it("splits a heading's words around an image in the middle, and keeps the image's link", () => {
		const blocks = gutenbergToPortableText(
			`<h2 style="text-align: center;">Before <a href="https://example.org/x/"><img src="https://example.org/x.png" alt="X" width="40" height="30" /></a> after <a href="https://example.org/y/">the link</a></h2>`,
		);
		expect(shape(blocks)).toEqual([
			"h2: Before",
			"[image x.png - 40x30 https://example.org/x/]",
			"h2: after the link",
		]);
		expect(blocks[0]).toMatchObject({ textAlign: "center" });
		expect((blocks[0] as PortableTextTextBlock).markDefs).toBeUndefined();
		// the words after the image name the one link they carry, not the image's
		expect(blocks[2]).toMatchObject({
			textAlign: "center",
			markDefs: [{ _type: "link", href: "https://example.org/y/" }],
		});
		expect(blocks[1]).toMatchObject({ alt: "X", asset: { url: "https://example.org/x.png" } });
	});

	it("keeps an image in a blockquote after the quote's words", () => {
		expect(
			shape(
				gutenbergToPortableText(
					`<blockquote>Said here. <img class="alignleft" src="https://example.org/q.png" alt="" /></blockquote>`,
				),
			),
		).toEqual(["blockquote: Said here.", "[image q.png left -x-]"]);
	});

	it("keeps a list item's text in the list on both sides of its image", () => {
		expect(
			shape(
				gutenbergToPortableText(
					`<ul><li>One <img src="https://example.org/1.png" alt="" /> more</li><li>Two</li></ul>`,
				),
			),
		).toEqual([
			"normal/bullet: One",
			"[image 1.png - -x-]",
			"normal/bullet: more",
			"normal/bullet: Two",
		]);
	});
});

describe("block editor content: an inline image", () => {
	const img = `<img class="wp-image-7" src="https://example.org/wp-content/uploads/icon.png" alt="Icon" width="24" height="24">`;

	it("keeps an inline image in a paragraph between the words around it", () => {
		const blocks = gutenbergToPortableText(`<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">Call us ${img} today.</p>
<!-- /wp:paragraph -->`);
		expect(shape(blocks)).toEqual([
			"normal: Call us",
			"[image icon.png - 24x24]",
			"normal: today.",
		]);
		expect(blocks[0]).toMatchObject({ textAlign: "center" });
		expect(blocks[2]).toMatchObject({ textAlign: "center" });
	});

	it("keeps an inline image in a heading, a list item and a quote", () => {
		const content = `<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">${img} A heading</h3>
<!-- /wp:heading -->

<!-- wp:list -->
<ul><li>Old list ${img}</li></ul>
<!-- /wp:list -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>New list ${img}</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:quote -->
<blockquote class="wp-block-quote"><p>A quote ${img}</p></blockquote>
<!-- /wp:quote -->`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"[image icon.png - 24x24]",
			"h3: A heading",
			"normal/bullet: Old list",
			"[image icon.png - 24x24]",
			"normal/bullet: New list",
			"[image icon.png - 24x24]",
			"blockquote: A quote",
			"[image icon.png - 24x24]",
		]);
	});

	it("keeps an empty paragraph out, as before, and an image alone in a paragraph as the image", () => {
		const blocks = gutenbergToPortableText(`<!-- wp:paragraph -->
<p></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>${img}</p>
<!-- /wp:paragraph -->`);
		expect(shape(blocks)).toEqual(["[image icon.png - 24x24]"]);
	});
});

describe("parseInlineSegments", () => {
	it("is parseInlineContent's one run for content that holds no image", () => {
		for (const html of [
			"",
			"   ",
			"<h2>Plain <strong>words</strong></h2>",
			'<a href="https://example.org/"></a>Text',
			'<img alt="no source" />Words',
			"Line one<br />line two",
		]) {
			expect(parseInlineSegments(html, counter())).toEqual([parseInlineContent(html, counter())]);
		}
	});

	it("passes over an image with no source, as WordPress draws nothing for it", () => {
		expect(parseInlineSegments('<img alt="none" />Title', counter())).toEqual([
			parseInlineContent('<img alt="none" />Title', counter()),
		]);
	});

	it("draws no run of white space or a line break alone beside an image", () => {
		const segments = parseInlineSegments(
			'<b> </b><br />\n<img src="https://example.org/a.png" />\n<br />',
			counter(),
		);
		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({ _type: "image" });
	});

	it("keeps a no-break space beside an image, the line WordPress draws for it", () => {
		const segments = parseInlineSegments(
			'&nbsp;<img src="https://example.org/a.png" />',
			counter(),
		);
		expect(
			segments.map((s) => ("_type" in s ? s._type : s.children.map((c) => c.text).join(""))),
		).toEqual(["\u00a0", "image"]);
	});
});
