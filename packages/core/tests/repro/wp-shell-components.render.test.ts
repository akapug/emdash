/**
 * The blog template's WpShell layout draws a migrated WordPress design, and
 * passes EmDash's PortableText two components of its own
 * (templates/blog-cloudflare/src/components): a stored left alignment as
 * WordPress's `has-text-align-left` class, and an image aligned left or right
 * as the `<img class="alignleft">` the theme floats. Everything else is
 * EmDash's own rendering.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import WpShellBlock from "../../../../templates/blog-cloudflare/src/components/WpShellBlock.astro";
import WpShellImage from "../../../../templates/blog-cloudflare/src/components/WpShellImage.astro";
import PortableText from "../../src/components/PortableText.astro";

const components = { block: WpShellBlock, type: { image: WpShellImage } };
const locals = { emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` } };

const block = (key: string, textAlign: string | undefined, text: string, style = "normal") => ({
	_type: "block",
	_key: key,
	style,
	...(textAlign ? { textAlign } : {}),
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
});
const image = (key: string, extra: Record<string, unknown>) => ({
	_type: "image",
	_key: key,
	asset: {
		_ref: "https://example.org/wp-content/uploads/a-300x256.png",
		url: "https://example.org/wp-content/uploads/a-300x256.png",
	},
	alt: "A picture",
	...extra,
});

async function render(value: unknown[], shell = true) {
	const c = await AstroContainer.create();
	return c.renderToString(PortableText, {
		props: { value, ...(shell ? { components } : {}) },
		locals,
	});
}

describe("the WpShell layout's content components", () => {
	it("draws a stored left as WordPress's class, and every other block as EmDash draws it", async () => {
		const html = await render([
			block("a", "left", "Left"),
			block("b", "center", "Centred"),
			block("c", undefined, "Plain"),
			block("d", "left", "Heading", "h3"),
		]);
		expect(html).toMatch(/<p class="has-text-align-left"[^>]*>Left<\/p>/);
		expect(html).toMatch(/<p class="has-text-align-center"[^>]*>Centred<\/p>/);
		expect(html).toMatch(/<p(?![^>]*class=)[^>]*>Plain<\/p>/);
		expect(html).toMatch(/<h3 class="has-text-align-left"[^>]*>Heading<\/h3>/);
		// a stored value that is not an alignment puts no class of its own on the page
		const odd = await render([block("e", "evil-class", "Odd"), block("f", "toString", "Proto")]);
		expect(odd).toMatch(/<p(?![^>]*class=)[^>]*>Odd<\/p>/);
		expect(odd).toMatch(/<p(?![^>]*class=)[^>]*>Proto<\/p>/);
		// EmDash's own renderer draws no class for its default
		expect(await render([block("a", "left", "Left")], false)).not.toContain("has-text-align-left");
	});

	it("draws an image aligned left or right as the theme's floated img, and any other image as EmDash's figure", async () => {
		const left = await render([image("l", { alignment: "left" })]);
		expect(left).toMatch(
			/<img class="alignleft" src="https:\/\/example\.org\/wp-content\/uploads\/a-300x256\.png" alt="A picture"/,
		);
		expect(left).not.toContain("<figure");
		expect(await render([image("r", { alignment: "right" })])).toMatch(/<img class="alignright"/);
		for (const other of [
			image("c", { alignment: "center" }),
			image("k", { alignment: "left", link: "https://example.org/" }),
			image("p", { alignment: "left", caption: "Pictured" }),
			image("j", { alignment: "left", asset: { _ref: "x", url: "javascript:alert(1)" } }),
			image("s", { alignment: "left", asset: { _ref: "y", url: "//elsewhere.example/a.png" } }),
		]) {
			const html = await render([other]);
			expect(html).toContain('<figure class="emdash-image');
			expect(html).not.toMatch(/class="align(left|right)"/);
		}
		// EmDash's own renderer draws its figure for the aligned image too
		expect(await render([image("l", { alignment: "left" })], false)).toContain(
			"emdash-image--align-left",
		);
	});
});
