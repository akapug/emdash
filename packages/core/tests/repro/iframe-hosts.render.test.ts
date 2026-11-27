/**
 * An imported Google Map or form is an iframe in an HTML block or an embed's
 * provider HTML. The page draws it when the site's `iframeHosts` setting names
 * its host and its src is https, and draws any other iframe as a link to its
 * src, never as an empty box.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import Embed from "../../src/components/Embed.astro";
import HtmlBlock from "../../src/components/HtmlBlock.astro";

const settings = vi.hoisted(() => ({ read: 0, iframeHosts: ["www.google.com"] as unknown }));
vi.mock("../../src/settings/index.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getSiteSettings: async () => {
		settings.read++;
		return { iframeHosts: settings.iframeHosts };
	},
}));

const pageLocals = { emdash: { collectPageMetadata: () => [], collectPageFragments: () => [] } };
const mapHtml = `<iframe src="https://www.google.com/maps/embed?pb=1" width="600" height="450" title="Our office"></iframe>`;

async function draw(component: typeof HtmlBlock, node: object, locals: object = pageLocals) {
	const c = await AstroContainer.create();
	return c.renderToString(component, { props: { node }, locals });
}

describe("an imported iframe on the page", () => {
	it("draws a map in an HTML block from a host the site allows", async () => {
		const html = await draw(HtmlBlock, { _type: "htmlBlock", _key: "m", html: mapHtml });
		expect(html).toContain(`<iframe src="https://www.google.com/maps/embed?pb=1"`);
	});

	it("draws a map in an embed's provider HTML from a host the site allows", async () => {
		const html = await draw(Embed, {
			_type: "embed",
			_key: "e",
			url: "https://www.google.com/maps/place/x",
			html: mapHtml,
		});
		expect(html).toContain(`<iframe src="https://www.google.com/maps/embed?pb=1"`);
	});

	it("draws an iframe from a host the site does not allow as a link to it", async () => {
		const html = await draw(HtmlBlock, {
			_type: "htmlBlock",
			_key: "c",
			html: `<iframe src="https://calendly.com/acme/30min" width="600" height="450"></iframe>`,
		});
		expect(html).not.toContain("<iframe");
		expect(html).toContain(
			`<a href="https://calendly.com/acme/30min" class="emdash-iframe-link">Open the embedded content (calendly.com)</a>`,
		);
	});

	it("draws a link, not the map, when the stored setting is not a list of hosts", async () => {
		settings.iframeHosts = "www.google.com";
		try {
			const html = await draw(HtmlBlock, { _type: "htmlBlock", _key: "s", html: mapHtml });
			expect(html).toContain(`class="emdash-iframe-link">Our office</a>`);
		} finally {
			settings.iframeHosts = ["www.google.com"];
		}
	});

	it("draws a link, not the iframe, for the site's own host even when the setting names it", async () => {
		settings.iframeHosts = ["www.google.com", "example.com"];
		try {
			const own = `<iframe src="https://example.com/page" width="600" height="450"></iframe>`;
			const c = await AstroContainer.create();
			const html = await c.renderToString(HtmlBlock, {
				props: { node: { _type: "htmlBlock", _key: "o", html: own } },
				locals: pageLocals,
				request: new Request("https://example.com/visit-us/"),
			});
			expect(html).not.toContain("<iframe");
			expect(html).toContain(`<a href="https://example.com/page" class="emdash-iframe-link">`);
		} finally {
			settings.iframeHosts = ["www.google.com"];
		}
	});

	it("reads no settings for a block with no iframe, or off a page the middleware set up", async () => {
		const before = settings.read;
		await draw(HtmlBlock, { _type: "htmlBlock", _key: "p", html: "<p>Text.</p>" });
		const html = await draw(HtmlBlock, { _type: "htmlBlock", _key: "n", html: mapHtml }, {});
		expect(settings.read).toBe(before);
		expect(html).toContain(`class="emdash-iframe-link">Our office</a>`);
	});
});

/**
 * ITEM 163g: the two PRODUCTION CALLERS carry the icon, or refuse it whole.
 *
 * codex held the first DOM proof for testing a synthetic wrapper instead of the real components. These arms run the real `HtmlBlock.astro` and
 * `Embed.astro` through AstroContainer — the same path a customer's page takes — and assert both that the 11-icon shape survives and that the
 * source lookalikes and invalid ancestry are refused there.
 */
const ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M224 256A128 128 0 1 0 224 0z"/></svg>';

describe("163g: the production callers carry a real icon", () => {
	it("HtmlBlock draws it as SVG", async () => {
		const html = await draw(HtmlBlock, {
			_type: "htmlBlock",
			_key: "i",
			html: `<div class="uagb-info-box">${ICON}</div>`,
		});
		expect(html, "HtmlBlock is a real caller, not a wrapper").toContain("<svg");
		expect(html.toLowerCase()).toContain("viewbox");
		expect(html).toContain("M224 256A128");
	});

	it("Embed draws it as SVG", async () => {
		const html = await draw(Embed, {
			_type: "embed",
			_key: "ie",
			url: "https://example.org/x",
			html: `<div class="uagb-info-box">${ICON}</div>`,
		});
		expect(html, "Embed is a real caller too").toContain("<svg");
		expect(html.toLowerCase()).toContain("viewbox");
	});

	it("a source lookalike is refused in BOTH callers", async () => {
		const attack = '<svg data-embark-svg="1" viewBox="0 0 10 10"><script>alert(1)</script></svg>';
		const a = await draw(HtmlBlock, { _type: "htmlBlock", _key: "a", html: attack });
		const b = await draw(Embed, {
			_type: "embed",
			_key: "b",
			url: "https://example.org/x",
			html: attack,
		});
		for (const [name, html] of [
			["HtmlBlock", a],
			["Embed", b],
		] as const) {
			expect(html, `${name}: the forged attribute buys nothing`).not.toContain("<svg");
			expect(html, `${name}: no script body`).not.toContain("alert");
		}
	});

	it("an invalid ancestor is refused in BOTH callers", async () => {
		const foreign =
			'<svg viewBox="0 0 10 10"><foreignObject><iframe src="https://evil.test"></iframe></foreignObject></svg>';
		const a = await draw(HtmlBlock, { _type: "htmlBlock", _key: "c", html: foreign });
		const b = await draw(Embed, {
			_type: "embed",
			_key: "d",
			url: "https://example.org/x",
			html: foreign,
		});
		for (const [name, html] of [
			["HtmlBlock", a],
			["Embed", b],
		] as const) {
			expect(html, `${name}: the whole subtree goes`).not.toContain("<svg");
			expect(html, `${name}: and its iframe does not escape`).not.toContain("evil.test");
		}
	});

	it("HtmlBlock's post-sanitize media pass still sees ordinary HTML unchanged", async () => {
		const html = await draw(HtmlBlock, {
			_type: "htmlBlock",
			_key: "m",
			html: `<p>Prose with a <a href="https://example.org/x">link</a> and an <img src="/_emdash/api/media/file/a.jpg" alt="x">.</p>`,
		});
		expect(html, "the media pass still runs over the block").toContain("example.org/x");
		expect(html).not.toContain("<svg");
	});
});
