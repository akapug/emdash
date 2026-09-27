/**
 * WordPress curls quotes and prints dashes and an ellipsis as it renders
 * (wptexturize); the export holds the straight ones the author typed. The
 * conversion stores what WordPress showed, and never touches markup, code,
 * or a shortcode's own text.
 */

import { describe, expect, it } from "vitest";

import { gutenbergToPortableText, wptexturize } from "../src/index.js";
import type { PortableTextBlock } from "../src/types.js";

const text = (blocks: PortableTextBlock[]) =>
	blocks.map((b) =>
		b._type === "block"
			? b.children.map((c) => c.text).join("")
			: b._type === "code"
				? `[code ${b.code}]`
				: `[${b._type}]`,
	);

describe("wptexturize: the rules WordPress documents", () => {
	it("prints WordPress's own example as WordPress does", () => {
		// developer.wordpress.org/reference/functions/wptexturize/
		expect(wptexturize(`'cause today's effort makes it worth tomorrow's "holiday" ...`)).toBe(
			"’cause today’s effort makes it worth tomorrow’s “holiday” …",
		);
	});

	it("curls double and single quotes, and an apostrophe in a word", () => {
		expect(wptexturize(`He said "hello" and 'goodbye'. It's done.`)).toBe(
			"He said “hello” and ‘goodbye’. It’s done.",
		);
		expect(wptexturize(`("in brackets") {and 'these'}`)).toBe("(“in brackets”) {and ‘these’}");
		expect(wptexturize("``double'' and the '90s")).toBe("“double” and the ’90s");
	});

	it("prints a spaced hyphen as an en dash, two as an em dash, and three anywhere as an em dash", () => {
		expect(wptexturize("pages 3-5 - see -- here---there left--right")).toBe(
			"pages 3-5 – see — here—there left–right",
		);
		// a punycode host keeps its xn--
		expect(wptexturize("xn--80ak6aa92e.com")).toBe("xn--80ak6aa92e.com");
	});

	it("prints primes after a number, a multiplication sign between two and a trademark sign", () => {
		expect(wptexturize(`a 9" board, 12' long`)).toBe("a 9″ board, 12′ long");
		expect(wptexturize("a 2x4, but 0x1F stays hex")).toBe("a 2×4, but 0x1F stays hex");
		expect(wptexturize("Brand (tm)")).toBe("Brand ™");
	});

	it("changes no markup: tags, attributes, comments and a block's JSON", () => {
		const html = `<!-- wp:paragraph {"align":"center","x":"a -- b"} --><p class="it's" title="say &quot;hi&quot;">"A" -- B</p><!-- /wp:paragraph -->`;
		expect(wptexturize(html)).toBe(
			`<!-- wp:paragraph {"align":"center","x":"a -- b"} --><p class="it's" title="say &quot;hi&quot;">“A” — B</p><!-- /wp:paragraph -->`,
		);
	});

	it("leaves the text of pre, code, kbd, tt, style and script as it was", () => {
		for (const tag of ["pre", "code", "kbd", "tt", "style", "script"]) {
			expect(wptexturize(`"a" <${tag} class="x">"b" -- 'c'</${tag}> "d"`)).toBe(
				`“a” <${tag} class="x">"b" -- 'c'</${tag}> “d”`,
			);
		}
		// nested: texturizing starts again only after the element that stopped it closes
		expect(wptexturize(`<pre>"a" <b>"b"</b></code> "c"</pre> "d"`)).toBe(
			`<pre>"a" <b>"b"</b></code> "c"</pre> “d”`,
		);
	});

	it("leaves a shortcode's own text and the content of [code] as they were", () => {
		expect(
			wptexturize(
				`[caption id="attachment_1" align="alignleft" width="300"]<img src="a.jpg"> It's "here"[/caption]`,
			),
		).toBe(
			`[caption id="attachment_1" align="alignleft" width="300"]<img src="a.jpg"> It’s “here”[/caption]`,
		);
		expect(wptexturize(`[code]"raw" -- it's[/code] "cooked"`)).toBe(
			`[code]"raw" -- it's[/code] “cooked”`,
		);
		// an escaped shortcode is text to WordPress's shortcode parser and stays as written
		expect(wptexturize(`[[gallery ids="1,2"]]`)).toBe(`[[gallery ids="1,2"]]`);
	});

	it("leaves a code highlighter's shortcode content as it was, where the post closes one", () => {
		// SyntaxHighlighter Evolved draws these as a <pre> before WordPress texturizes
		expect(wptexturize(`[php]echo "a" . 'b'; // x -- y...[/php] "after"`)).toBe(
			`[php]echo "a" . 'b'; // x -- y...[/php] “after”`,
		);
		expect(wptexturize(`[sourcecode language="js"]x = "y" -- 1[/sourcecode] it's`)).toBe(
			`[sourcecode language="js"]x = "y" -- 1[/sourcecode] it’s`,
		);
		// a bracketed word that is never closed does not stop the rest of the post
		expect(wptexturize(`Reply [text] "here" -- now`)).toBe("Reply [text] “here” — now");
	});

	it("leaves a bare URL as it is, for the embed it may be", () => {
		expect(wptexturize("see https://example.org/a--b...c 'now'")).toBe(
			"see https://example.org/a--b...c ‘now’",
		);
		// the quotes around it read as they do around any word
		expect(wptexturize(`"https://example.org/x" said`)).toBe("“https://example.org/x” said");
	});

	it("leaves a run that holds one of its own stand-in characters as it was", () => {
		// an icon font's glyph typed as its private-use character
		for (const c of ["", "", "", "", ""]) {
			expect(wptexturize(`It's "${c}" here`)).toBe(`It's "${c}" here`);
		}
		// only that run: the next one is texturized as ever
		expect(wptexturize(`<i> it's</i> it's`)).toBe(`<i> it's</i> it’s`);
	});

	it("reads a long run of unclosed markup in one pass", () => {
		const hostile = `${"[a ".repeat(20_000)}${"<!--".repeat(5_000)}`;
		const t = performance.now();
		wptexturize(hostile);
		expect(performance.now() - t).toBeLessThan(2_000);
	});
});

describe("gutenbergToPortableText stores the text as WordPress showed it", () => {
	it("in classic content and in blocks, and never in a code block", () => {
		expect(text(gutenbergToPortableText(`It's "here" - now...\n\n<pre>"raw" --</pre>`))).toEqual([
			"It’s “here” – now…",
			'[code "raw" --]',
		]);
		const blocks = `<!-- wp:paragraph --><p>"Quoted" -- <strong>it's</strong></p><!-- /wp:paragraph -->
<!-- wp:code --><pre class="wp-block-code"><code>x = "y" -- z</code></pre><!-- /wp:code -->`;
		expect(text(gutenbergToPortableText(blocks))).toEqual([
			"“Quoted” — it’s",
			'[code x = "y" -- z]',
		]);
	});

	it("keeps the stored text when asked to", () => {
		expect(text(gutenbergToPortableText(`It's "here"`, { texturize: false }))).toEqual([
			`It's "here"`,
		]);
	});
});
