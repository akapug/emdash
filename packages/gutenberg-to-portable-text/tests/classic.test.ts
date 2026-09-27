/**
 * Classic editor content is drawn by WordPress through wpautop: a blank line
 * ends a paragraph, any other newline is a line break. Converted as saved,
 * a migrated services page was one paragraph of run-together lines where
 * WordPress drew a paragraph per service, each with its name on a line of
 * its own. And an image the classic editor aligned floats where WordPress
 * floats it.
 */

import { describe, expect, it } from "vitest";

import { gutenbergToPortableText } from "../src/index.js";
import type { PortableTextBlock } from "../src/types.js";

/** Each text block's text, "\n" for a line break; an image block as its alignment. */
const shape = (blocks: PortableTextBlock[]) =>
	blocks.map((b) =>
		b._type === "block"
			? b.children.map((c) => c.text).join("")
			: b._type === "image"
				? `[image ${b.alignment ?? "-"}]`
				: b._type,
	);

describe("classic content: paragraphs and line breaks as WordPress draws them", () => {
	it("makes a paragraph of each run between blank lines, and a line break of every other newline", () => {
		const content = `<b>Bike Repair</b><span style="font-weight: 400;">
</span><span style="font-weight: 400;">We fix most kinds of bicycles.</span>

<strong>Tune-ups
</strong>A full service in a day.

<b>Spare Parts</b>
<h3>Other Services</h3>
<b>Riding Lessons</b>
This service is for new riders.`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Bike Repair\nWe fix most kinds of bicycles.",
			"Tune-ups\nA full service in a day.",
			"Spare Parts",
			"Other Services",
			"Riding Lessons\nThis service is for new riders.",
		]);
	});

	it("draws a board member's name and titles on lines of their own, and a line break once", () => {
		const content = `<h3>Board Members</h3>
<strong>A. Example</strong>
Vice President, Example Co
Chair, Example &amp; Sons

<strong>B. Sample</strong><br />
Treasurer, Example Co`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Board Members",
			"A. Example\nVice President, Example Co\nChair, Example & Sons",
			"B. Sample\nTreasurer, Example Co",
		]);
	});

	it("leaves preformatted text as it was written", () => {
		const blocks = gutenbergToPortableText("Words.\n\n<pre>a\n\nb</pre>");
		expect(blocks.map((b) => b._type)).toEqual(["block", "code"]);
		expect(blocks[1]).toMatchObject({ _type: "code", code: "a\n\nb" });
	});

	it("takes the paragraph off a shortcode that stands alone in one, as shortcode_unautop does", () => {
		// the importer's caption handling reads the opener, then the image, then
		// the caption and the closer: the shape the content has before wpautop
		const content = `Before the picture.

[caption id="attachment_1" align="alignleft" width="300"]<img class="size-medium wp-image-1" src="https://example.org/a.png" alt="" width="300" height="200" /> A caption[/caption]

After the picture.

[gravityform id="2" title="false"]`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Before the picture.",
			'[caption id="attachment_1" align="alignleft" width="300"]',
			"[image -]",
			"A caption[/caption]",
			"After the picture.",
			'[gravityform id="2" title="false"]',
		]);
	});

	it("does not run block content through it: WordPress does not either", () => {
		const content = `<!-- wp:paragraph -->
<p>One
two</p>
<!-- /wp:paragraph -->`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["One\ntwo"]);
	});
});

describe("classic content: an aligned image", () => {
	it("carries the classic editor's alignment class to the image block", () => {
		const content = `<p style="text-align: left;"><img class="alignleft wp-image-15 size-medium" src="https://example.org/a.png" alt="" width="300" height="256" />Words beside the picture.</p>
<p><a href="https://example.org/b/"><img class="size-full alignright" src="https://example.org/b.png" alt="B" /></a></p>
<img class="aligncenter" src="https://example.org/c.png" alt="C" />
<p><img class="text-alignleft" src="https://example.org/d.png" alt="D" /></p>`;
		const blocks = gutenbergToPortableText(content);
		expect(shape(blocks)).toEqual([
			"[image left]",
			"Words beside the picture.",
			"[image right]",
			"[image center]",
			"[image -]",
		]);
		expect(blocks[1]).toMatchObject({ textAlign: "left" });
		expect(blocks[2]).toMatchObject({ link: "https://example.org/b/" });
	});
});

describe("an image keeps the size WordPress drew it at", () => {
	const size = (b: PortableTextBlock | undefined) =>
		b?._type === "image" ? [b.displayWidth, b.displayHeight] : b?._type;

	it("reads the classic editor's width and height on every image it converts", () => {
		// the classic editor's medium size: a -300x256 file, drawn 300 by 256
		const content = `<p><img class="alignleft wp-image-15 size-medium" src="https://example.org/wp-content/uploads/a-300x256.png" alt="" width="300" height="256" />Words beside the picture.</p>
<p><a href="https://example.org/b/"><img class="alignright" src="https://example.org/b.png" alt="B" width='120' height='90' /></a></p>
<img class="aligncenter" src="https://example.org/c.png" alt="C" width=640 height=480>
<figure><img src="https://example.org/d.png" alt="D" width="200" height="100" /><figcaption>D</figcaption></figure>`;
		const blocks = gutenbergToPortableText(content);
		expect(blocks.filter((b) => b._type === "image").map(size)).toEqual([
			[300, 256],
			[120, 90],
			[640, 480],
			[200, 100],
		]);
		expect(blocks[0]).toMatchObject({
			alignment: "left",
			asset: { url: "https://example.org/wp-content/uploads/a-300x256.png" },
		});
	});

	it("reads a block editor image's width and height, which it writes when the image was resized", () => {
		const content = `<!-- wp:image {"id":5,"width":320,"height":200,"sizeSlug":"large"} -->
<figure class="wp-block-image size-large is-resized"><img src="https://example.org/e-1024x640.jpg" alt="E" class="wp-image-5" width="320" height="200"/></figure>
<!-- /wp:image -->`;
		expect(size(gutenbergToPortableText(content)[0])).toEqual([320, 200]);
	});

	it("records no size where the tag gives none, or none in whole pixels", () => {
		for (const img of [
			`<img src="https://example.org/f.png" alt="F" />`,
			`<img src="https://example.org/f.png" alt="F" width="100%" height="auto" />`,
			`<img src="https://example.org/f.png" alt="width=300 height=200" />`,
			`<img src="https://example.org/f.png" data-width="300" data-height="200" />`,
			`<img src="https://example.org/f.png" width="0" height="-4" />`,
		]) {
			const [image] = gutenbergToPortableText(`<p>${img}</p>`);
			expect(image).toMatchObject({ _type: "image" });
			expect(image).not.toHaveProperty("displayWidth");
			expect(image).not.toHaveProperty("displayHeight");
		}
		// the first of a repeated attribute counts, and a width alone is kept alone
		const [first] = gutenbergToPortableText(
			`<p><img src="https://example.org/g.png" width="100%" width="300" height="200" /></p>`,
		);
		expect(size(first)).toEqual([undefined, 200]);
	});
});

describe("classic content: what WordPress draws that a converter would drop or join", () => {
	it("keeps a paragraph that holds a no-break space alone, as the line WordPress draws for it", () => {
		const content = `Via a newsletter: a short note on the week.\n\n&nbsp;\n\nThe second paragraph.\n\n&nbsp;`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Via a newsletter: a short note on the week.",
			"\u00a0",
			"The second paragraph.",
			"\u00a0",
		]);
		// white space alone is no paragraph, as before
		expect(shape(gutenbergToPortableText("One.\n\n<p>   </p>\n\nTwo."))).toEqual(["One.", "Two."]);
	});

	it("draws each paragraph of a div that wraps the post apart, and what follows the div after it", () => {
		const content = `<div id="post-body" class="content">\n\n<em><strong>A first line.</strong></em>\n\nThe middle paragraph.\n\n<em>A last line.</em>\n\n</div>\n\n<b>Follow along.</b>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"A first line.",
			"The middle paragraph.",
			"A last line.",
			"Follow along.",
		]);
		// a div of text alone is still one paragraph
		expect(
			shape(gutenbergToPortableText('<div class="note">A note, and <em>its</em> end.</div>')),
		).toEqual(["A note, and its end."]);
	});
});
