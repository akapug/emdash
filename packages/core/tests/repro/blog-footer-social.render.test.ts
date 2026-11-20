/**
 * The blog template's footer draws the site's "social" menu in its Connect
 * column, beside the feed: one link per item, in the menu's order. A migrated
 * site's follow links arrive in that menu (Embark's social-menu fixup), so a
 * site with none still shows the feed alone.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import SocialLinks from "../../../../templates/blog-cloudflare/src/components/SocialLinks.astro";

const item = (id: string, label: string, url: string, extra: object = {}) => ({
	id,
	label,
	url,
	children: [],
	...extra,
});

async function draw(menu: unknown) {
	const c = await AstroContainer.create();
	return c.renderToString(SocialLinks, { props: { menu } });
}

describe("the footer's social links", () => {
	it("draws each item of the social menu as a link, in its order", async () => {
		const html = await draw({
			id: "m",
			name: "social",
			label: "Social Links",
			locale: "en",
			translationGroup: null,
			items: [
				item("1", "GitHub", "https://github.com/example"),
				item("2", "Mastodon", "https://mastodon.social/@example", { target: "_blank" }),
			],
		});
		const links = Array.from(html.matchAll(/<li><a ([^>]*)>([^<]*)<\/a><\/li>/g), (m) => [
			m[2],
			m[1],
		]);
		expect(links.map(([label]) => label)).toEqual(["GitHub", "Mastodon"]);
		expect(links[0]![1]).toContain('href="https://github.com/example"');
		expect(links[0]![1]).not.toContain("target");
		expect(links[1]![1]).toContain('target="_blank"');
		expect(links[1]![1]).toContain('rel="noopener noreferrer"');
	});

	it("draws nothing when the site has no social menu", async () => {
		expect((await draw(null)).trim()).toBe("");
	});
});
