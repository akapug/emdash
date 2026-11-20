import { describe, expect, it } from "vitest";

import {
	gutenbergToPortableText,
	htmlToPortableText,
	type ConvertOptions,
	type PortableTextBlock,
} from "../src/index.js";

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
