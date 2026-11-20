import { describe, expect, it } from "vitest";

import {
	gutenbergToPortableText as compiledConverter,
	htmlToPortableText as compiledHtmlConverter,
} from "../dist/index.mjs";
import {
	gutenbergToPortableText,
	htmlToPortableText,
	type ConvertOptions,
	type PortableTextBlock,
} from "../src/index.js";
import { drawsLine, withoutUndrawn } from "../src/inline.js";

const publicOptions = (): ConvertOptions => ({
	texturize: false,
	keyGenerator: () => "synthetic",
	shortcode: (raw) =>
		raw.startsWith("[MEC")
			? [
					{
						_type: "embed",
						_key: "synthetic-event",
						provider: "synthetic",
						url: "https://example.org",
					},
				]
			: undefined,
});

const shortcode: NonNullable<ConvertOptions["shortcode"]> = (raw, { generateKey }) =>
	/^\[MEC\s+id=73\]$/i.test(raw)
		? [{ _type: "embed", _key: generateKey(), provider: "events", url: "/events/" }]
		: undefined;
const spans = (blocks: PortableTextBlock[]) =>
	blocks.flatMap((b) => (b._type === "block" ? b.children : []));
const text = (blocks: PortableTextBlock[]) =>
	spans(blocks)
		.map((s) => s.text)
		.join("");

describe.each([
	{ name: "source Gutenberg", convert: gutenbergToPortableText },
	{ name: "compiled Gutenberg", convert: compiledConverter },
	{ name: "source HTML", convert: htmlToPortableText },
	{ name: "compiled HTML", convert: compiledHtmlConverter },
])("single-cell embed layout: $name", ({ convert }) => {
	it.each([
		"<table><tr><td> \n<br>[MEC id=73]<br /> \n</td></tr></table>",
		'<!-- wp:table --><figure class="wp-block-table"><table><tbody><tr><td><br>[MEC id=73]</td></tr></tbody></table></figure><!-- /wp:table -->',
	])("unwraps only the single resolved embed and invokes its resolver once: %s", (source) => {
		const options = publicOptions();
		const calls: string[] = [];
		const blocks = convert(source, {
			...options,
			shortcode: (raw, context) => {
				calls.push(raw);
				return options.shortcode?.(raw, context);
			},
		});
		// The HTML entrypoint keeps empty runs around Gutenberg delimiter comments;
		// they are outside the table and draw nothing, just as they did without this cure.
		expect(blocks.filter((block) => block._type !== "block" || drawsLine(block.children))).toEqual([
			{
				_type: "embed",
				_key: "synthetic-event",
				provider: "synthetic",
				url: "https://example.org",
			},
		]);
		expect(calls).toEqual(["[MEC id=73]"]);
	});

	it.each([
		"<table><tr><td>[MEC id=73]</td><td></td></tr></table>",
		"<table><tr><td>[MEC id=73] Real content</td></tr></table>",
		"<table><tr><td>[MEC id=73] [MEC id=73]</td></tr></table>",
		"<table><tr><td colspan=2>[MEC id=73]</td></tr></table>",
		"<table><caption>Real caption</caption><tr><td>[MEC id=73]</td></tr></table>",
	])("keeps the named refusal for a genuine table or meaningful other content: %s", (source) => {
		expect(() => convert(source, publicOptions())).toThrow(/span-only/);
	});

	it("preserves no-hook and unknown-hook tables without duplicate callback invocations", () => {
		const source = "<table><tr><td><br>[UNKNOWN id=73]</td></tr></table>";
		const options = { texturize: false, keyGenerator: () => "synthetic" };
		const calls: string[] = [];
		const ordinary = convert(source, options);
		expect(ordinary[0]?._type).toBe("table");
		expect(
			convert(source, {
				...options,
				shortcode: (raw) => {
					calls.push(raw);
					return undefined;
				},
			}),
		).toEqual(ordinary);
		expect(calls).toEqual(["[UNKNOWN id=73]"]);
	});

	it("does not activate encoded literal brackets in the sole cell", () => {
		const blocks = convert("<table><tr><td>&#91;MEC id=73&#93;</td></tr></table>", publicOptions());
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?._type).toBe("table");
	});
});

describe.each([
	{ name: "source", convert: gutenbergToPortableText },
	{ name: "compiled dist/index.mjs", convert: compiledConverter },
])("public shortcode boundary regressions: $name", ({ convert }) => {
	it.each([
		"<ul><li>&#91;MEC id=73&#93;</li></ul>",
		"<ul><li><strong>&lbrack;MEC id=73&rbrack;</strong></li></ul>",
		"<ol><li><p>&#x5b;MEC id=73&#x5d;</p></li></ol>",
		"<ol><li>Before<ul><li>&#91;MEC id=73&#93;</li></ul>After</li></ol>",
	])("preserves raw literal provenance through list DOM traversal: %s", (source) => {
		const blocks = convert(source, publicOptions());
		expect(blocks.filter((b) => b._type === "embed")).toHaveLength(0);
		expect(text(blocks)).toContain("[MEC id=73]");
	});

	it.each([
		"<!-- <script> --><p>[MEC id=73]</p><!-- </script> -->",
		'<div data-open="<script>">Before</div><p>[MEC id=73]</p><div data-close="</script>">After</div>',
		"<script>const note = '<!--'; [MEC id=73]</script><p>[MEC id=73]</p>",
	])("observes browser comment, attribute and raw-text order: %s", (source) => {
		expect(convert(source, publicOptions()).filter((b) => b._type === "embed")).toHaveLength(1);
	});

	it("keeps the refuted comment-only shortcode negative control inactive", () => {
		const blocks = convert("<!-- <p>[MEC id=73]</p> --><p>Visible text</p>", publicOptions());
		expect(blocks.filter((b) => b._type === "embed")).toHaveLength(0);
		expect(text(blocks)).toContain("Visible text");
	});

	it("does not leak a throwing table conversion's cursor into the next entry", () => {
		expect(() =>
			convert(
				"<table><tr><td>[MEC id=73]</td><td>Other content</td></tr></table>",
				publicOptions(),
			),
		).toThrow(/span-only/);
		const next = convert("<h2>Visible heading</h2><p>Visible paragraph</p>", publicOptions());
		expect(next.map((b) => (b._type === "block" ? b.style : b._type))).toEqual(["h2", "normal"]);
		expect(text(next)).toBe("Visible headingVisible paragraph");
		const table = convert(
			"<table><tr><td>First</td><td>Second</td></tr><tr><td>Third</td><td>Fourth</td></tr></table>",
			publicOptions(),
		)[0];
		expect(table?._type).toBe("table");
		if (table?._type !== "table") throw new Error("Missing next table");
		expect(
			table.rows.map((row) =>
				row.cells.map((cell) => cell.content.map((span) => span.text).join("")),
			),
		).toEqual([
			["First", "Second"],
			["Third", "Fourth"],
		]);
	});

	it("keeps the outer cursor private when a public shortcode callback converts recursively", () => {
		let calls = 0;
		const options = publicOptions();
		const blocks = convert("<p>[MEC id=73]</p><h2>Outer heading</h2>", {
			...options,
			shortcode: (raw, context) => {
				calls++;
				if (calls === 1) convert("<div><p>Inner paragraph</p></div>", { texturize: false });
				return options.shortcode?.(raw, context);
			},
		});
		expect(calls).toBe(1);
		expect(blocks.map((b) => (b._type === "block" ? b.style : b._type))).toEqual(["embed", "h2"]);
	});
});

it("removes only actual undrawn element source ranges and preserves ordinary bytes", () => {
	const ordinary =
		'<div title="<script>">Before</div><!-- <style> --><p>Visible</p><!-- </style> --><div title="</script>">After</div>';
	expect(withoutUndrawn(ordinary)).toBe(ordinary);
	expect(
		withoutUndrawn(
			'<p>Before</p><script data-note=">">ignored</script><style>ignored</style><noscript>ignored</noscript><p>After</p>',
		),
	).toBe("<p>Before</p><p>After</p>");
});

describe("native visible-source shortcode hook", () => {
	it.each([
		[
			"classic",
			'<p><a href="https://example.org/info"><strong>Before [MEC id=73] after</strong></a> and [[MEC id=73]].</p>',
		],
		[
			"Gutenberg paragraph",
			"<!-- wp:paragraph --><p><strong>Before [MEC id=73] after</strong> and [[MEC id=73]].</p><!-- /wp:paragraph -->",
		],
		[
			"Gutenberg shortcode",
			"<!-- wp:paragraph --><p>Before</p><!-- /wp:paragraph --><!-- wp:shortcode -->[MEC id=73]<!-- /wp:shortcode --><!-- wp:paragraph --><p>After</p><!-- /wp:paragraph -->",
		],
		[
			"Gutenberg HTML",
			"<!-- wp:html --><p><strong>Before [MEC id=73] after</strong> and [[MEC id=73]].</p><!-- /wp:html -->",
		],
	])("places an embed in %s without losing surrounding content", (_name, source) => {
		const blocks = gutenbergToPortableText(source, { shortcode });
		const at = blocks.findIndex((b) => b._type === "embed");
		expect(at).toBeGreaterThan(0);
		expect(blocks.filter((b) => b._type === "embed")).toHaveLength(1);
		expect(text(blocks.slice(0, at))).toContain("Before");
		expect(text(blocks.slice(at + 1))).toMatch(/after/i);
		if (source.includes("<strong>")) {
			expect(spans(blocks.slice(0, at))).toContainEqual(
				expect.objectContaining({ text: "Before ", marks: expect.arrayContaining(["strong"]) }),
			);
		}
	});

	it("reads raw text before decoding entities and never scans attributes, comments or undrawn text", () => {
		const seen: string[] = [];
		const blocks = gutenbergToPortableText(
			'<p><a href="https://example.org/?literal=[MEC id=73]">Before</a> &#91;MEC id=73&#93; &lbrack;MEC id=73&rbrack; [[MEC id=73]] [mEc id=73]</p><!-- [MEC id=73] --><script>[MEC id=73]</script><style>[MEC id=73]</style>',
			{
				shortcode: (raw, context) => {
					seen.push(raw);
					return shortcode(raw, context);
				},
			},
		);
		expect(seen).toEqual(["[mEc id=73]"]);
		expect(blocks.filter((b) => b._type === "embed")).toHaveLength(1);
		expect(text(blocks)).toContain("[MEC id=73]");
		expect(spans(blocks).flatMap((s) => s.marks ?? [])).not.toContain("script");
	});

	it("preserves the no-option and undefined-hook conversion byte for byte", () => {
		const source =
			"<p>Before [[MEC id=73]] [MEC id=73] &#91;MEC id=73&#93; <strong>after</strong>.</p>";
		const options = () => {
			let count = 0;
			return { keyGenerator: () => `key-${++count}` };
		};
		expect(gutenbergToPortableText(source, { ...options(), shortcode: () => undefined })).toEqual(
			gutenbergToPortableText(source, options()),
		);
	});

	it("carries through column layout and images with the same callback", () => {
		const blocks = gutenbergToPortableText(
			'<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column {"width":"80%"} --><div class="wp-block-column"><!-- wp:paragraph --><p>Before [MEC id=73] after <img src="https://example.org/a.png" alt="Picture"></p><!-- /wp:paragraph --></div><!-- /wp:column --></div><!-- /wp:columns -->',
			{ shortcode },
		);
		const columns = blocks[0];
		expect(columns?._type).toBe("columns");
		if (columns?._type !== "columns") throw new Error("Missing native columns");
		expect(columns.columns[0]?.width).toBe("80%");
		expect(columns.columns[0]?.content.map((b) => b._type)).toEqual([
			"block",
			"embed",
			"block",
			"image",
		]);
	});

	it("uses the hook in plain HTML too, leaving unknown shortcodes literal", () => {
		const blocks = htmlToPortableText("<p>[OTHER id=73] [MEC id=73]</p>", { shortcode });
		expect(text(blocks)).toBe("[OTHER id=73] ");
		expect(blocks.at(-1)?._type).toBe("embed");
	});
});
