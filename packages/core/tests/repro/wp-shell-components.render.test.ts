/**
 * The blog template's WpShell layout draws a migrated WordPress design, and
 * passes EmDash's PortableText two components of its own
 * (templates/blog-cloudflare/src/components): a stored left alignment as
 * WordPress's `has-text-align-left` class, and an image aligned left or right
 * as the `<img class="alignleft">` the theme floats, and a video embedded
 * from a link in classic content as WordPress's paragraph and player.
 * Everything else is EmDash's own rendering.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import WpShellBlock from "../../../../templates/blog-cloudflare/src/components/WpShellBlock.astro";
import WpShellEmbed from "../../../../templates/blog-cloudflare/src/components/WpShellEmbed.astro";
import WpShellImage from "../../../../templates/blog-cloudflare/src/components/WpShellImage.astro";
import PortableText from "../../src/components/PortableText.astro";

const components = { block: WpShellBlock, type: { image: WpShellImage, embed: WpShellEmbed } };
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

describe("the WpShell layout's embeds", () => {
	const embed = (key: string, extra: Record<string, unknown>) => ({
		_type: "embed",
		_key: key,
		...extra,
	});

	it("draws a video embedded from a link in classic content as WordPress's paragraph and player", async () => {
		const html = await render([
			embed("v", { url: "https://vimeo.com/100000001", provider: "vimeo" }),
		]);
		expect(html).toMatch(
			/<p[^>]*>\s*<iframe class="wp-shell-embed" src="https:\/\/player\.vimeo\.com\/video\/100000001" title="Vimeo video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen[^>]*><\/iframe>\s*<\/p>/,
		);
		expect(html).not.toContain("<figure");
		expect(await render([embed("y", { url: "https://youtu.be/dQw4w9WgXcQ" })])).toContain(
			'src="https://www.youtube.com/embed/dQw4w9WgXcQ"',
		);
	});

	it("draws every other embed as EmDash's own figure", async () => {
		for (const other of [
			embed("g", { url: "https://vimeo.com/1", html: '<figure class="wp-block-embed">x</figure>' }),
			embed("t", { url: "https://twitter.com/x/status/1" }),
			embed("s", { url: "https://example.org/v.mp4", provider: "video" }),
		]) {
			const html = await render([other]);
			expect(html).toContain('<figure class="emdash-embed');
			expect(html).not.toContain("wp-shell-embed");
		}
		// EmDash's own renderer draws its figure for the classic video too
		expect(await render([embed("v", { url: "https://vimeo.com/100000001" })], false)).toContain(
			'<figure class="emdash-embed',
		);
	});
});
