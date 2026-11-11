/**
 * Classic content puts blocks inside other blocks: a quote holds paragraphs and
 * a list, a list item holds the next list down, a table holds rows of cells.
 * Read as one run of text, a migrated quote's list ran its items together
 * ("…training data knowledgeTake bold counterfactual…"), the items after a
 * nested list fell out of their list, and a table's cells read as one word.
 */

import { describe, expect, it } from "vitest";

import { gutenbergToPortableText } from "../src/index.js";
import type { PortableTextBlock, PortableTextTableBlock } from "../src/types.js";

/** Each block as its style, list and text; a table as its rows of cell text. */
const shape = (blocks: PortableTextBlock[]) =>
	blocks.map((b) => {
		if (b._type === "block") {
			const list = b.listItem ? ` ${b.listItem}${b.level}` : "";
			return `${b.style}${list}: ${b.children.map((c) => c.text).join("")}`;
		}
		if (b._type === "table") {
			const rows = (b as PortableTextTableBlock).rows;
			return `table ${rows.map((r) => r.cells.map((c) => c.content.map((s) => s.text).join("")).join("|")).join(" / ")}`;
		}
		if (b._type === "image") return `[image ${b.asset.url?.split("/").pop()}]`;
		return `[${b._type}]`;
	});

describe("classic content: a quote that holds blocks", () => {
	it("keeps a list in a quote a list, its items apart (a migrated post's quote, as saved)", () => {
		const content = `<section itemprop="text">

        <blockquote>
  <p>“To create an Einstein in a data center, we don’t just need a system that knows all the answers.
…
If we want scientific breakthroughs, we should test if scientific AI models can for instance:</p>
  <ul>
    <li>Challenge their own training data knowledge</li>
    <li>Take bold counterfactual approaches</li>
    <li>Make general proposals based on tiny hints</li>
    <li>Ask non-obvious questions that lead to new research paths”</li>
  </ul>
</blockquote>

<p><a href="https://x.com/Thom_Wolf/status/1">Thomas Wolf on X</a></p>
      </section>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"blockquote: “To create an Einstein in a data center, we don’t just need a system that knows all the answers.\n…\nIf we want scientific breakthroughs, we should test if scientific AI models can for instance:",
			"normal bullet1: Challenge their own training data knowledge",
			"normal bullet1: Take bold counterfactual approaches",
			"normal bullet1: Make general proposals based on tiny hints",
			"normal bullet1: Ask non-obvious questions that lead to new research paths”",
			"normal: Thomas Wolf on X",
		]);
	});

	it("keeps a quote's heading a heading and each paragraph a paragraph of the quote", () => {
		const content = `<blockquote style="text-align: right;"><h3>Head</h3><p>One</p><p>Two</p><cite>Someone</cite></blockquote>`;
		const blocks = gutenbergToPortableText(content);
		expect(shape(blocks)).toEqual([
			"h3: Head",
			"blockquote: One",
			"blockquote: Two",
			"blockquote: Someone",
		]);
		expect(blocks[1]).toMatchObject({ textAlign: "right" });
	});

	it("keeps a quote's paragraphs after a quote inside it in the quote", () => {
		const content = `<blockquote><p>a</p><blockquote><p>b</p></blockquote><p>c</p></blockquote><p>after</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"blockquote: a",
			"blockquote: b",
			"blockquote: c",
			"normal: after",
		]);
	});

	it("keeps a quote of one paragraph one block, its image after its words", () => {
		const content = `<blockquote>Said here. <img src="https://example.org/q.png" alt="" /></blockquote>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"blockquote: Said here.",
			"[image q.png]",
		]);
	});
});

describe("classic content: a list inside a list item", () => {
	it("makes the inner list the next level down and keeps the items after it in the list", () => {
		const content = `<ul>
<li>alpha
<ul>
<li>beta</li>
</ul>
</li>
<li>gamma</li>
</ul>
<ol><li>one<ol><li>two</li></ol></li><li>three</li></ol>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"normal bullet1: alpha",
			"normal bullet2: beta",
			"normal bullet1: gamma",
			"normal number1: one",
			"normal number2: two",
			"normal number1: three",
		]);
	});
});

describe("classic content: a table", () => {
	it("makes a table of text a table, each cell's words its own", () => {
		const content = `<table>
<caption>Board</caption>
<thead>
<tr><th>Name</th><th>Role</th></tr>
</thead>
<tr>
<td><span>Ann</span></td>
<td>Chair</td>
</tr>
<tfoot><tr><td>Total</td><td>1</td></tr></tfoot>
</table>`;
		const blocks = gutenbergToPortableText(content);
		expect(shape(blocks)).toEqual(["normal: Board", "table Name|Role / Ann|Chair / Total|1"]);
		expect(blocks[1]).toMatchObject({ hasHeaderRow: true });
	});

	it("draws a table that lays out images as its cells' content in order", () => {
		const content = `<table><tr><td><img src="https://example.org/a.png" alt="" /></td><td>Beside the image</td></tr><tr><td>Below</td><td>Last</td></tr></table>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"[image a.png]",
			"normal: Beside the image",
			"normal: Below",
			"normal: Last",
		]);
	});
});

describe("classic content: other containers of blocks", () => {
	it("keeps what a figure with no image holds", () => {
		const content = `<figure class="wp-block-table"><table><tr><td>x</td><td>y</td></tr></table><figcaption>Caption</figcaption></figure>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["table x|y", "normal: Caption"]);
	});

	it("draws each term and description of a definition list on its own line", () => {
		const content = `<dl><dt>Term</dt><dd>Definition</dd></dl>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["normal: Term", "normal: Definition"]);
	});
});

describe("block editor content: a table's footer", () => {
	it("keeps the rows of a table block's footer section", () => {
		const content = `<!-- wp:table -->
<figure class="wp-block-table"><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>b</td></tr></tbody><tfoot><tr><td>c</td></tr></tfoot></table></figure>
<!-- /wp:table -->`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["table A / b / c"]);
	});
});
