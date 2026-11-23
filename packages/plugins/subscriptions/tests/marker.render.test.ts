/**
 * emb/97 fork half — the marker in imported HTML becomes the plugin's form.
 *
 * This renders the template's htmlBlock override, which is the component a
 * migrated page's HTML block goes through. The arm is about the BYTES A
 * VISITOR IS SERVED: the form is there, it posts to the plugin's route, and
 * the text either side of the marker keeps its place.
 *
 * The plugin's status route is faked: a site whose plugin does not answer
 * draws no form, and that is the other arm.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

const MARKER = '<div data-embark-subscribe="1"></div>';

/** Render the template's htmlBlock override with the plugin answering or not. */
async function render(html: string, answers: boolean) {
	vi.resetModules();
	vi.doMock("emdash/plugin-utils", () => ({
		getPublicPluginApiRouteHandler: () =>
			answers
				? async () => ({ success: true, data: { confirmed: 3 } })
				: null,
	}));
	// HtmlBlock is mocked because the real one pulls in PortableText, which
	// needs the `virtual:emdash/block-components` module this package's test
	// config does not provide. The mock emits the HTML as MARKUP, which is what
	// the real block does (set:html) — a mock returning a raw string is escaped
	// by Astro, and that is not what a page serves.
	const { createComponent } = await import("astro/runtime/server/index.js");
	const { unescapeHTML } = await import("astro/runtime/server/escape.js");
	vi.doMock("emdash/ui", () => ({
		HtmlBlock: createComponent((_result: unknown, props: { node: { html: string } }) => unescapeHTML(props.node.html)),
	}));
	const { default: WpShellHtmlBlock } = await import(
		"../../../../templates/blog-cloudflare/src/components/WpShellHtmlBlock.astro"
	);
	const container = await AstroContainer.create();
	return container.renderToString(WpShellHtmlBlock, {
		props: { node: { _type: "htmlBlock", _key: "k1", html } },
		request: new Request(new URL("/posts/hello", "https://site.test")),
	});
}

describe("emb/97: a marker in imported HTML", () => {
	it("THE FORM IS DRAWN, posting to the plugin's subscribe route", async () => {
		const out = await render(`<p>Before</p>${MARKER}<p>After</p>`, true);
		expect(out).toContain("/_emdash/api/plugins/emdash-subscriptions/subscribe");
		expect(out).toContain('type="email"');
		// The marker itself is gone: it was a record, and now it is the form.
		expect(out).not.toContain("data-embark-subscribe");
	});

	it("MID-ARTICLE STAYS MID-ARTICLE: the text either side is in order", async () => {
		const out = await render(`<p>Before</p>${MARKER}<p>After</p>`, true);
		const before = out.indexOf("Before");
		const form = out.indexOf("ec-subscribe-form");
		const after = out.indexOf("After");
		expect(before).toBeGreaterThan(-1);
		expect(form).toBeGreaterThan(before);
		expect(after).toBeGreaterThan(form);
	});

	it("A SITE WHOSE PLUGIN DOES NOT ANSWER DRAWS NO FORM", async () => {
		const out = await render(`<p>Before</p>${MARKER}<p>After</p>`, false);
		expect(out).not.toContain("ec-subscribe-form");
		// And the page's own text is still there: the marker is not a reason to
		// lose what the customer wrote.
		expect(out).toContain("Before");
		expect(out).toContain("After");
	});

	it("CONTROL: an HTML block with no marker is drawn as it was", async () => {
		const out = await render("<p>just words</p>", true);
		expect(out).toContain("just words");
		expect(out).not.toContain("ec-subscribe-form");
	});
});
