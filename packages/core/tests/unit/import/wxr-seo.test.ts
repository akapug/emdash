import { describe, expect, it } from "vitest";

import type { WxrPost } from "../../../src/cli/wxr/parser.js";
import {
	emptyWxrSeoTally,
	extractWxrSeo,
	tallyWxrSeo,
	wxrSeoSite,
	wxrUrlKey,
} from "../../../src/import/wxr-seo.js";

const SITE = { title: "Example Garden", description: "Plants and paths", link: "https://example.org" };
const IMAGE = "https://example.org/wp-content/uploads/2024/05/pond.jpg";

function site(entryPaths: Record<string, string> = {}) {
	return wxrSeoSite(
		SITE,
		[{ id: 42, url: IMAGE }],
		new Map(Object.entries(entryPaths).map(([url, path]) => [wxrUrlKey(url)!, path])),
	);
}

function post(meta: Record<string, string>, extra: Partial<WxrPost> = {}): WxrPost {
	return {
		id: 7,
		title: "The Pond",
		link: "https://example.org/the-pond/",
		postName: "the-pond",
		postType: "page",
		categories: [],
		tags: [],
		meta: new Map(Object.entries(meta)),
		...extra,
	};
}

describe("extractWxrSeo: titles", () => {
	it("carries a literal Yoast title and removes the site name EmDash appends itself", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_title: "Visit the pond - Example Garden" }), site());
		expect(out.seo.title).toBe("Visit the pond");
		expect(out.notes).not.toContain("site-name-appended");
	});

	it("resolves Yoast variables the export holds", () => {
		const out = extractWxrSeo(
			post({ _yoast_wpseo_title: "Our %%title%% guide %%page%% %%sep%% %%sitename%%" }),
			site(),
		);
		expect(out.seo.title).toBe("Our The Pond guide");
		expect(out.dropped).toEqual([]);
	});

	it("resolves Rank Math and All in One SEO variables", () => {
		expect(
			extractWxrSeo(post({ rank_math_title: "%title% for %sitedesc% %sep% %sitename%" }), site()).seo
				.title,
		).toBe("The Pond for Plants and paths");
		expect(
			extractWxrSeo(post({ _aioseo_title: "#post_title at #tagline #separator_sa #site_title" }), site())
				.seo.title,
		).toBe("The Pond at Plants and paths");
	});

	it("keeps a literal # word that is not an All in One SEO tag", () => {
		expect(extractWxrSeo(post({ _aioseo_title: "#1 pond in town" }), site()).seo.title).toBe(
			"#1 pond in town",
		);
	});

	it("drops a title whose variable the export has no value for, and names the variable", () => {
		const out = extractWxrSeo(
			post({ _yoast_wpseo_title: "Best pond of %%currentyear%% %%sep%% %%sitename%%" }),
			site(),
		);
		expect(out.seo.title).toBeUndefined();
		expect(out.dropped).toEqual([
			{ field: "title", reason: "unresolved-variable", variables: ["currentyear"] },
		]);
	});

	it("drops a title whose separator is not at the end, since its value is a plugin setting", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_title: "%%sitename%% %%sep%% %%title%%" }), site());
		expect(out.seo.title).toBeUndefined();
		expect(out.dropped).toEqual([{ field: "title", reason: "unresolved-variable", variables: ["sep"] }]);
	});

	it("stores nothing when the title resolves to the entry's own title", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_title: "%%title%% %%sep%% %%sitename%%" }), site());
		expect(out.seo).toEqual({});
		expect(out.asDefault).toEqual(["title"]);
	});

	it("drops a title that is only the site name", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_title: "%%sitename%%" }), site());
		expect(out.seo.title).toBeUndefined();
		expect(out.dropped).toEqual([{ field: "title", reason: "only-the-site-name" }]);
	});

	it("notes a custom title without the site name, which EmDash will append", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_title: "Koi and lilies" }), site());
		expect(out.seo.title).toBe("Koi and lilies");
		expect(out.notes).toEqual(["site-name-appended"]);
	});

	it("drops a title longer than the SEO panel accepts", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_title: "x".repeat(201) }), site());
		expect(out.dropped).toEqual([{ field: "title", reason: "too-long" }]);
	});
});

describe("extractWxrSeo: descriptions", () => {
	it("carries a meta description and resolves its variables", () => {
		const out = extractWxrSeo(
			post({ _yoast_wpseo_metadesc: "Walk to %%title%%, part of %%sitename%%." }),
			site(),
		);
		expect(out.seo.description).toBe("Walk to The Pond, part of Example Garden.");
	});

	it("drops a description built from an excerpt the export does not have", () => {
		const out = extractWxrSeo(post({ rank_math_description: "%excerpt%" }), site());
		expect(out.seo.description).toBeUndefined();
		expect(out.dropped).toEqual([
			{ field: "description", reason: "unresolved-variable", variables: ["excerpt"] },
		]);
	});

	it("stores nothing when the description is the excerpt EmDash already uses", () => {
		const out = extractWxrSeo(
			post({ _yoast_wpseo_metadesc: "%%excerpt%%" }, { excerpt: "A still pond." }),
			site(),
		);
		expect(out.seo.description).toBeUndefined();
		expect(out.asDefault).toEqual(["description"]);
	});
});

describe("extractWxrSeo: robots", () => {
	it("carries Yoast noindex and notes that EmDash also sends nofollow", () => {
		const out = extractWxrSeo(post({ "_yoast_wpseo_meta-robots-noindex": "1" }), site());
		expect(out.seo.noIndex).toBe(true);
		expect(out.notes).toEqual(["noindex-adds-nofollow"]);
	});

	it("reads Rank Math robots from the serialized array WordPress exports", () => {
		const out = extractWxrSeo(
			post({ rank_math_robots: 'a:2:{i:0;s:7:"noindex";i:1;s:8:"nofollow";}' }),
			site(),
		);
		expect(out.seo.noIndex).toBe(true);
		expect(out.notes).toEqual([]);
	});

	it("drops nofollow without noindex, which EmDash has no field for", () => {
		const out = extractWxrSeo(
			post({ rank_math_robots: 'a:2:{i:0;s:5:"index";i:1;s:8:"nofollow";}' }),
			site(),
		);
		expect(out.seo.noIndex).toBeUndefined();
		expect(out.dropped).toEqual([{ field: "robots", reason: "nofollow-without-noindex" }]);
	});

	it("reads Yoast's explicit index (2) as nothing to carry", () => {
		const out = extractWxrSeo(post({ "_yoast_wpseo_meta-robots-noindex": "2" }), site());
		expect(out.found).toBe(false);
	});
});

describe("extractWxrSeo: canonical", () => {
	it("leaves a canonical to the entry itself to EmDash, which points it at the new URL", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_canonical: "https://www.example.org/the-pond" }), site());
		expect(out.seo.canonical).toBeUndefined();
		expect(out.asDefault).toEqual(["canonical"]);
	});

	it("rewrites a canonical to another imported entry to that entry's new URL", () => {
		const out = extractWxrSeo(
			post({ rank_math_canonical_url: "https://example.org/garden-map/" }),
			site({ "https://example.org/garden-map/": "/pages/garden-map" }),
		);
		expect(out.seo.canonical).toBe("https://example.org/pages/garden-map");
	});

	it("drops a canonical that points off the site", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_canonical: "https://example.net/the-pond/" }), site());
		expect(out.dropped).toEqual([{ field: "canonical", reason: "off-site" }]);
	});

	it("drops an on-site canonical that names no imported entry", () => {
		const out = extractWxrSeo(post({ _yoast_wpseo_canonical: "https://example.org/category/news/" }), site());
		expect(out.dropped).toEqual([{ field: "canonical", reason: "not-an-entry" }]);
	});
});

describe("extractWxrSeo: social image", () => {
	it("carries the image by attachment id", () => {
		const out = extractWxrSeo(
			post({
				"_yoast_wpseo_opengraph-image": "https://cdn.example.net/other.jpg",
				"_yoast_wpseo_opengraph-image-id": "42",
			}),
			site(),
		);
		expect(out.seo.image).toBe(IMAGE);
	});

	it("carries the image by URL, including a resized copy of an attachment", () => {
		const out = extractWxrSeo(
			post({ rank_math_facebook_image: "https://example.org/wp-content/uploads/2024/05/pond-1024x768.jpg" }),
			site(),
		);
		expect(out.seo.image).toBe(IMAGE);
	});

	it("drops an image that is not one of the export's attachments", () => {
		const out = extractWxrSeo(
			post({ "_yoast_wpseo_opengraph-image": "https://cdn.example.net/other.jpg" }),
			site(),
		);
		expect(out.seo.image).toBeUndefined();
		expect(out.dropped).toEqual([{ field: "image", reason: "not-in-media" }]);
	});
});

describe("tallyWxrSeo", () => {
	it("counts carried fields, defaults, drops and the variables behind them", () => {
		const tally = emptyWxrSeoTally();
		const s = site();
		tallyWxrSeo(tally, extractWxrSeo(post({ _yoast_wpseo_title: "Koi", _yoast_wpseo_metadesc: "Fish." }), s));
		tallyWxrSeo(tally, extractWxrSeo(post({ _yoast_wpseo_title: "%%title%% %%currentyear%%" }), s));
		tallyWxrSeo(tally, extractWxrSeo(post({ _yoast_wpseo_focuskw: "pond" }), s));
		expect(tally.entries).toBe(2);
		expect(tally.carried).toMatchObject({ title: 1, description: 1, robots: 0 });
		expect(tally.dropped).toEqual({ "title:unresolved-variable": 1 });
		expect(tally.unresolvedVariables).toEqual({ currentyear: 1 });
		expect(tally.notes).toEqual({ "site-name-appended": 1 });
	});
});
