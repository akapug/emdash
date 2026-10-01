/**
 * A classic post wrapped whole in a `<div>` is read block by block, and an
 * iframe is lifted out of the paragraph it stands in. Lifted from the div
 * instead, the iframe cut through the div's blocks: a list, a heading or a
 * quote became runs of plain text around it. An iframe inside a list item,
 * a heading or a quote is dropped, as before, and the block keeps its shape.
 */

import { describe, expect, it } from "vitest";

import { gutenbergToPortableText } from "../src/index.js";
import type { PortableTextBlock } from "../src/types.js";

const WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YOUTUBE = `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>`;

/** Each text block as its list kind or style and its text; an embed as its URL. */
const shape = (blocks: PortableTextBlock[]) =>
	blocks.map((b) =>
		b._type === "block"
			? `${b.listItem ?? b.style}: ${b.children
					.map((c) => c.text)
					.join("")
					.replace(/\s+/g, " ")
					.trim()}`
			: b._type === "embed"
				? `[embed ${b.url}]`
				: `[${b._type}]`,
	);

describe("classic iframes in a div that holds blocks", () => {
	it("keeps a list's items apart around an iframe in one of them", () => {
		const content = `<div class="x"><ul><li>Video: ${YOUTUBE} tail</li><li>Two</li></ul></div>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["bullet: Video: tail", "bullet: Two"]);
	});

	it("keeps a heading a heading around an iframe in it", () => {
		const content = `<div class="x"><h2>Title ${YOUTUBE}</h2><p>Para</p></div>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["h2: Title", "normal: Para"]);
	});

	it("keeps a quote a quote around an iframe in it", () => {
		const content = `<div class="post"><p>Intro</p><blockquote>Said ${YOUTUBE} this</blockquote><p>Out</p></div>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"normal: Intro",
			"blockquote: Said this",
			"normal: Out",
		]);
	});

	it("lifts an iframe out of the div's paragraph, in its place among the div's blocks", () => {
		const content = `<div class="post"><h2>Title</h2><p>Intro</p><p>${YOUTUBE}</p><ul><li>a</li><li>b</li></ul></div>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"h2: Title",
			"normal: Intro",
			`[embed ${WATCH_URL}]`,
			"bullet: a",
			"bullet: b",
		]);
	});

	it("keeps the alignment of the paragraph an iframe was lifted from on the text either side", () => {
		const content = `<div class="post"><p style="text-align: center">Watch: ${YOUTUBE} now</p><p>Outro</p></div>`;
		const result = gutenbergToPortableText(content);

		expect(shape(result)).toEqual([
			"normal: Watch:",
			`[embed ${WATCH_URL}]`,
			"normal: now",
			"normal: Outro",
		]);
		expect(result.map((b) => (b._type === "block" ? (b.textAlign ?? "-") : b._type))).toEqual([
			"center",
			"embed",
			"center",
			"-",
		]);
	});
});
