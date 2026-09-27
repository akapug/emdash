/**
 * A stylesheet, a script and a scripts-off fallback (`<noscript>`) draw no
 * text. WordPress prints them as they are, and the browser draws none of
 * their text: a page builder's text widget carries its own `<style>`, which
 * the converter drew as a paragraph of CSS, run into the widget's first words.
 */

import { describe, expect, it } from "vitest";

import { gutenbergToPortableText } from "../src/index.js";
import { extractText, parseInlineContent } from "../src/inline.js";
import type { PortableTextBlock } from "../src/types.js";

/** Each text block as its style and text; an image block as its file and caption; an HTML block as its HTML. */
const shape = (blocks: PortableTextBlock[]) =>
	blocks.map((b) =>
		b._type === "block"
			? `${b.style}: ${b.children.map((c) => c.text).join("")}`
			: b._type === "image"
				? `[image ${b.asset.url?.split("/").pop()}${b.caption ? ` "${b.caption}"` : ""}]`
				: b._type === "htmlBlock"
					? `html: ${b.html}`
					: b._type,
	);

describe("classic content: what the reader never sees is no text", () => {
	it("draws no stylesheet the content holds, though wpautop put paragraph tags inside it", () => {
		// a page builder's text widget as the post keeps it: its own stylesheet, then its words
		const content = `<style>/*! builder */
.widget-text .drop-cap{background-color:#69727d;color:#fff}

.widget-text .drop-cap{float:left}
</style>
<p>The first words.</p>
More words.`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"normal: The first words.",
			"normal: More words.",
		]);
	});

	it("reads no paragraph in a script's text, and draws no scripts-off fallback", () => {
		const content = `Before.

<script>
var note = "<p>not drawn</p>";

show(note);
</script>

After.

<noscript>Turn on scripts to see the map.</noscript>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["normal: Before.", "normal: After."]);
	});

	it("takes no image from a scripts-off fallback: a tracking pixel is no picture", () => {
		const content = `<p>A map of the area.<noscript><img src="https://example.org/pixel.gif" width="1" height="1" /></noscript></p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["normal: A map of the area."]);
	});
});

describe("block content: what the reader never sees is no text", () => {
	it("draws no stylesheet or script a paragraph or a heading holds", () => {
		const content = `<!-- wp:paragraph -->
<p>Hi<style>.a{color:red}</style> there</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Head<script>track()</script></h2>
<!-- /wp:heading -->`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["normal: Hi there", "h2: Head"]);
		expect(
			parseInlineContent("One <noscript>two </noscript>three", () => "k")
				.children.map((c) => c.text)
				.join(""),
		).toBe("One three");
	});

	it("reads no stylesheet or script into an image's caption or any text it extracts", () => {
		const content = `<!-- wp:image {"id":3} -->
<figure class="wp-block-image"><img src="https://example.org/c.png" alt=""/><figcaption class="wp-element-caption">A caption<style>.x{}</style></figcaption></figure>
<!-- /wp:image -->`;
		expect(shape(gutenbergToPortableText(content))).toEqual(['[image c.png "A caption"]']);
		expect(extractText("Words<script>x()</script>")).toBe("Words");
	});

	it("keeps a custom HTML block as it was written, for the site's sanitizer to draw", () => {
		const content = `<!-- wp:html -->
<style>.x{color:red}</style><div class="x">Boxed</div>
<!-- /wp:html -->`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			'html: <style>.x{color:red}</style><div class="x">Boxed</div>',
		]);
	});
});
