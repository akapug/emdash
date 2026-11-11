/**
 * What a site moved from another platform needs of the blog template at
 * cutover: its follow links in the footer, and its old feed addresses.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GET as atomXml } from "../../../../../templates/blog-cloudflare/src/pages/atom.xml";
import { GET as feedXml } from "../../../../../templates/blog-cloudflare/src/pages/feed.xml";
import { GET as indexXml } from "../../../../../templates/blog-cloudflare/src/pages/index.xml";

const template = (rel: string): string =>
	readFileSync(
		new URL(`../../../../../templates/blog-cloudflare/src/${rel}`, import.meta.url),
		"utf8",
	);

describe("an old feed address at a file name", () => {
	// EmDash's redirects never look up a path with a file extension, so the
	// template answers Jekyll's /feed.xml and /atom.xml and Hugo's /index.xml.
	it.each([
		["/feed.xml", feedXml],
		["/atom.xml", atomXml],
		["/index.xml", indexXml],
	])("%s is a permanent redirect to /rss.xml", async (_path, get) => {
		const asked: Array<[string, number | undefined]> = [];
		const redirect = (to: string, status?: number) => {
			asked.push([to, status]);
			return new Response(null, { status, headers: { location: to } });
		};
		const res = await get({ redirect } as unknown as Parameters<typeof get>[0]);
		expect(asked).toEqual([["/rss.xml", 301]]);
		expect(res).toBeInstanceOf(Response);
		expect((res as Response).status).toBe(301);
	});
});

describe("the footer's Connect column", () => {
	it("asks for the social menu, caches by it, and draws it before the feed", () => {
		const source = template("layouts/Base.astro");
		expect(source).toContain('import SocialLinks from "../components/SocialLinks.astro";');
		expect(source).toContain('getMenuWithCacheHint("social")');
		expect(source).toContain("Astro.cache.set(socialResult.cacheHint);");
		const connect = source.slice(source.indexOf(">Connect</h2>"));
		const list = connect.slice(0, connect.indexOf("</ul>"));
		expect(list.indexOf("<SocialLinks menu={socialMenu} />")).toBeGreaterThan(-1);
		expect(list.indexOf("<SocialLinks menu={socialMenu} />")).toBeLessThan(
			list.indexOf('<a href="/rss.xml">RSS Feed</a>'),
		);
	});
});
