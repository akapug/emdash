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
