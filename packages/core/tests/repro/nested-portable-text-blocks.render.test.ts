/**
 * A column of a `columns` block, and a cover's content, are drawn with the
 * components the page drew the block with.
 *
 * They used to be drawn with the bare `astro-portabletext` renderer and only
 * EmDash's marks, so every block type in them but text was its unknown type,
 * `display:none`: an image in a column (the usual shape of an imported
 * two-column WordPress layout) was on the page and invisible.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Columns from "../../src/components/Columns.astro";
import PortableText from "../../src/components/PortableText.astro";
import MarkerHtmlBlock from "./MarkerHtmlBlock.astro";

const locals = { emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` } };

const para = (key: string, text: string) => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
});
const image = {
	_type: "image",
	_key: "img",
	asset: { _ref: "01IMAGE", url: "/_emdash/api/media/file/01IMAGE.jpg" },
	alt: "A pool at dusk",
};
const columns = (key: string, ...contents: unknown[][]) => ({
	_type: "columns",
	_key: key,
	columns: contents.map((content, i) => ({
		_type: "column",
		_key: `${key}-${i}`,
		content,
		width: "50%",
	})),
});

async function render(value: unknown[], components?: Record<string, unknown>) {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, {
		props: { value, ...(components ? { components } : {}) },
		locals,
	});
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the content of a columns block", () => {
	it("draws an image in a column", async () => {
		const html = await render([columns("cols", [para("p", "Left words")], [image])]);
		expect(html).toContain("Left words");
		expect(html).toMatch(/<img\b[^>]*alt="A pool at dusk"/);
		expect(html).not.toContain("data-portabletext-unknown");
	});

	it("draws a columns block nested in a column", async () => {
		const html = await render([
			columns("outer", [para("a", "A")], [columns("inner", [para("c", "C")], [para("d", "D")])]),
		]);
		expect(count(html, 'class="emdash-columns"')).toBe(2);
		expect(html).toContain(">D<");
		expect(html).not.toContain("data-portabletext-unknown");
	});

	it("keeps each column's width", async () => {
		const html = await render([columns("cols", [para("a", "A")], [para("b", "B")])]);
		expect(count(html, "flex-basis: 50%")).toBe(2);
	});

	it("draws a column's content with the page's own overrides", async () => {
		const html = await render(
			[columns("cols", [{ _type: "htmlBlock", _key: "h1", html: "<p>raw</p>" }], [para("b", "B")])],
			{
				type: { htmlBlock: MarkerHtmlBlock },
			},
		);
		expect(html).toContain('data-override="htmlBlock" data-key="h1"');
		expect(html).not.toContain("<p>raw</p>");
	});

	it("draws EmDash's own blocks in a columns block rendered on its own", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Columns, {
			props: { node: columns("cols", [image], [para("b", "B")]) },
			locals,
		});
		expect(html).toMatch(/<img\b[^>]*alt="A pool at dusk"/);
		expect(html).not.toContain("data-portabletext-unknown");
	});
});

describe("the content of a cover block", () => {
	it("draws a cover's content with the page's own components", async () => {
		const cover = {
			_type: "cover",
			_key: "cover",
			content: [
				para("t", "Over the image"),
				{ _type: "htmlBlock", _key: "h2", html: "<p>raw</p>" },
			],
		};
		const html = await render([cover], { type: { htmlBlock: MarkerHtmlBlock } });
		expect(html).toContain("Over the image");
		expect(html).toContain('data-override="htmlBlock" data-key="h2"');
	});

	it("draws a pullquote in a cover", async () => {
		const html = await render([
			{
				_type: "cover",
				_key: "cover",
				content: [{ _type: "pullquote", _key: "q", text: "Plant a seed" }],
			},
		]);
		expect(html).toContain("emdash-pullquote");
		expect(html).not.toContain("data-portabletext-unknown");
	});
});
