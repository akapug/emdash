import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import PageArticle from "../../../../templates/blog-cloudflare/src/components/PageArticle.astro";
import WpShellEmbed from "../../../../templates/blog-cloudflare/src/components/WpShellEmbed.astro";

vi.mock("emdash", () => ({}));
vi.mock("../../dist/index.mjs", () => ({}));

const node = {
	_type: "embed",
	_key: "view",
	provider: "embark-events",
	url: "/events/",
	events: { viewSlug: "settings-not-carried" },
};
describe("an imported saved event view without its settings", () => {
	it("does not masquerade as an ordinary shell embed", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(WpShellEmbed, { props: { node } });
		expect(html).toContain("Saved event view unavailable");
		expect(html).toContain('href="/events/"');
	});
	it("does not masquerade as an ordinary regular Portable Text embed", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(PageArticle, {
			props: { title: "Calendar", content: [node], edit: {} },
		});
		expect(html).toContain("Saved event view unavailable");
		expect(html).toContain('href="/events/"');
	});
});
