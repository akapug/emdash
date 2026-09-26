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
