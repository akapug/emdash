import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import { describe, expect, it } from "vitest";

import {
	buildBaseUrlMap,
	findMatchingUrl,
	getBaseUrl,
	rewritePortableTextUrls,
	rewriteStringUrls,
} from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";
import type { PortableTextBlock } from "../../../src/astro/routes/api/import/wordpress/rewrite-url-helpers.js";

describe("WordPress import URL rewriting", () => {
	const oldOriginalUrl = "https://example.com/wp-content/uploads/2026/01/hero.jpg";
	const oldVariantUrl = "https://example.com/wp-content/uploads/2026/01/hero-1024x695.jpg";
	const newUrl = "/_emdash/media/file/imported/hero.jpg";
	const urlMap = { [oldOriginalUrl]: newUrl };

	it("strips query strings for base matching without changing filenames", () => {
		expect(getBaseUrl(`${oldVariantUrl}?w=1024`)).toBe(oldVariantUrl);
	});

	it("matches Portable Text image asset URLs that use a WordPress size suffix", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const blocks = [
			{
				_type: "image",
				asset: {
					_type: "reference",
					_ref: oldVariantUrl,
					url: oldVariantUrl,
				},
			},
		];

		const result = rewritePortableTextUrls(blocks, urlMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.asset?.url).toBe(newUrl);
		expect(blocks[0]?.asset?._ref).toBe(newUrl);
	});

	it("matches string URLs that use a WordPress size suffix", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const result = rewriteStringUrls(
			`<img src="${oldVariantUrl}?resize=1024,695" alt="Hero">`,
			urlMap,
			baseMap,
		);

		expect(result).toEqual({
			newValue: `<img src="${newUrl}" alt="Hero">`,
			changed: true,
			urlsRewritten: 1,
		});
	});

	it("matches unquoted image URLs followed by a closing tag delimiter", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const result = rewriteStringUrls(`<img src=${oldVariantUrl}>`, urlMap, baseMap);

		expect(result).toEqual({
			newValue: `<img src=${newUrl}>`,
			changed: true,
			urlsRewritten: 1,
		});
	});

	it("keeps exact matching for original attachment URLs", () => {
		const baseMap = buildBaseUrlMap(urlMap);

		expect(findMatchingUrl(oldOriginalUrl, urlMap, baseMap)).toBe(newUrl);
	});

	it("preserves dimension-named original attachment URLs while matching their variants", () => {
		const dimensionNamedOriginal =
			"https://example.com/wp-content/uploads/2026/01/banner-300x250.jpg";
		const dimensionNamedVariant =
			"https://example.com/wp-content/uploads/2026/01/banner-300x250-150x125.jpg";
		const importedUrl = "/_emdash/media/file/imported/banner-300x250.jpg";
		const exactMap = { [dimensionNamedOriginal]: importedUrl };
		const baseMap = buildBaseUrlMap(exactMap);

		expect(findMatchingUrl(dimensionNamedVariant, exactMap, baseMap)).toBe(importedUrl);
	});

	it("does not rewrite URL prefixes inside longer filenames", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const value = `<img src="${oldVariantUrl}.webp" alt="Hero">`;

		expect(rewriteStringUrls(value, urlMap, baseMap)).toEqual({
			newValue: value,
			changed: false,
			urlsRewritten: 0,
		});
	});

	it("rewrites bare variant URLs followed by prose punctuation", () => {
		const baseMap = buildBaseUrlMap(urlMap);

		expect(rewriteStringUrls(`Image: ${oldVariantUrl}, next`, urlMap, baseMap)).toEqual({
			newValue: `Image: ${newUrl}, next`,
			changed: true,
			urlsRewritten: 1,
		});

		expect(rewriteStringUrls(`Image: ${oldVariantUrl}.`, urlMap, baseMap)).toEqual({
			newValue: `Image: ${newUrl}.`,
			changed: true,
			urlsRewritten: 1,
		});
	});

	it("rewrites an attachment URL only where it ends, never the start of a longer file's URL", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const webp = `${oldOriginalUrl}.webp`;
		const picture = (img: string) =>
			`<picture><source srcset="${webp} 1x, ${webp} 2x" type="image/webp"><img src="${img}" srcset="${img} 1x, ${webp} 2x"></picture>`;
		expect(rewriteStringUrls(picture(oldOriginalUrl), urlMap, baseMap)).toEqual({
			newValue: picture(newUrl),
			changed: true,
			urlsRewritten: 1,
		});

		const longer = `${oldOriginalUrl}-1 ${oldOriginalUrl}_x ${oldOriginalUrl}/x ${oldOriginalUrl}x`;
		expect(rewriteStringUrls(longer, urlMap, baseMap)).toEqual({
			newValue: longer,
			changed: false,
			urlsRewritten: 0,
		});
	});

	it("still rewrites an attachment URL followed by a query, a fragment, url()'s paren or an entity", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const value = (u: string) =>
			`<img src="${u}?ver=2"><a href="${u}#top">x</a><div style="background:url(${u})"></div>{&quot;src&quot;:&quot;${u}&quot;} ${u}&#038;w=1 ${u}`;
		expect(rewriteStringUrls(value(oldOriginalUrl), urlMap, baseMap).newValue).toBe(value(newUrl));
	});

	it("rewrites a size variant only where it ends, beside its own .webp", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const value = (u: string) => `<img src="${u}"><source srcset="${oldVariantUrl}.webp">`;
		expect(rewriteStringUrls(value(oldVariantUrl), urlMap, baseMap).newValue).toBe(value(newUrl));
	});

	it("rewrites the longer of two attachment URLs as its own, when one begins the other", () => {
		const scaled = "https://example.com/wp-content/uploads/2026/01/hero.jpg-scaled.jpg";
		const exactMap = { [oldOriginalUrl]: newUrl, [scaled]: "/_emdash/media/file/imported/scaled.jpg" };
		const baseMap = buildBaseUrlMap(exactMap);
		expect(rewriteStringUrls(`<img src="${scaled}"> <img src="${oldOriginalUrl}">`, exactMap, baseMap).newValue).toBe(
			`<img src="/_emdash/media/file/imported/scaled.jpg"> <img src="${newUrl}">`,
		);

		// A key that carries a query is its own URL, whichever key the map lists first.
		const versioned = `${oldOriginalUrl}?ver=2`;
		const both = { [oldOriginalUrl]: newUrl, [versioned]: "/_emdash/media/file/imported/v2.jpg" };
		expect(rewriteStringUrls(`<img src="${versioned}"> <img src="${oldOriginalUrl}?ver=3">`, both, buildBaseUrlMap(both)).newValue).toBe(
			`<img src="/_emdash/media/file/imported/v2.jpg"> <img src="${newUrl}?ver=3">`,
		);
	});

	it("rewrites a legacy string image link", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const blocks = [
			{
				_type: "image",
				asset: { _type: "reference", _ref: "/already/local.jpg", url: "/already/local.jpg" },
				link: oldVariantUrl,
			},
		];

		const result = rewritePortableTextUrls(blocks, urlMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.link).toBe(newUrl);
	});

	it("rewrites an object image link in place and keeps its blank flag", () => {
		const baseMap = buildBaseUrlMap(urlMap);
		const blocks = [
			{
				_type: "image",
				asset: { _type: "reference", _ref: "/already/local.jpg", url: "/already/local.jpg" },
				link: { href: oldVariantUrl, blank: true },
			},
		];

		const result = rewritePortableTextUrls(blocks, urlMap, baseMap);

		expect(result).toEqual({ changed: true, urlsRewritten: 1 });
		expect(blocks[0]?.link).toEqual({ href: newUrl, blank: true });
	});
});

describe("WordPress import URL rewriting reaches links, not only images", () => {
	const brochure = "https://example.com/wp-content/uploads/2016/02/brochure.pdf";
	const imported = "/_emdash/api/media/file/01KBROCHURE.pdf";
	const hero = "https://example.com/wp-content/uploads/2016/02/hero-1024x695.jpg";
	const heroImported = "/_emdash/api/media/file/01KHERO.jpg";
	const urlMap = {
		[brochure]: imported,
		"https://example.com/wp-content/uploads/2016/02/hero.jpg": heroImported,
	};
	const baseMap = buildBaseUrlMap(urlMap);
	const convert = (html: string): PortableTextBlock[] =>
		gutenbergToPortableText(html) as PortableTextBlock[];

	it("rewrites a hyperlink to an imported attachment, as the importer's converter stores it", () => {
		const blocks = convert(
			`<!-- wp:paragraph -->\n<p>Read the <a href="${brochure}">preliminary study</a>.</p>\n<!-- /wp:paragraph -->`,
		);
		expect(blocks[0]?.markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: brochure }),
		]);

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 1,
		});
		expect(blocks[0]?.markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: imported }),
		]);
	});

	it("rewrites a hyperlink in a classic-editor post, and a size of an image", () => {
		const blocks = convert(
			`<p><a href="${brochure}">PDF</a> and <a href="${hero}">the picture</a></p>`,
		);

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 2,
		});
		expect(blocks[0]?.markDefs).toEqual([
			expect.objectContaining({ href: imported }),
			expect.objectContaining({ href: heroImported }),
		]);
	});

	it("leaves a link the import did not bring across", () => {
		const other = "https://example.com/about/";
		const blocks = convert(`<p><a href="${other}">About</a></p>`);

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: false,
			urlsRewritten: 0,
		});
		expect(blocks[0]?.markDefs).toEqual([expect.objectContaining({ href: other })]);
	});

	it("rewrites a table cell's link, a file block, buttons and a cover's background and content", () => {
		const blocks: PortableTextBlock[] = [
			{
				_type: "table",
				_key: "t",
				rows: [
					{
						_type: "tableRow",
						_key: "r",
						cells: [
							{
								_type: "tableCell",
								_key: "c",
								content: [],
								markDefs: [{ _type: "link", _key: "l", href: brochure }],
							},
						],
					},
				],
			},
			{ _type: "file", _key: "f", url: brochure, filename: "brochure.pdf" },
			{ _type: "button", _key: "b", text: "Download", url: brochure },
			{
				_type: "buttons",
				_key: "bs",
				buttons: [{ _type: "button", _key: "b1", text: "Get it", url: brochure }],
			},
			{
				_type: "cover",
				_key: "cv",
				backgroundImage: hero,
				content: [
					{
						_type: "block",
						_key: "p",
						children: [],
						markDefs: [{ _type: "link", _key: "l2", href: brochure }],
					},
				],
			},
		];

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 6,
		});
		expect(JSON.stringify(blocks)).not.toContain("example.com");
	});
});

describe("an image the rewrite moves onto its upload keeps the size WordPress drew it at", () => {
	// The classic editor's medium size of an upload: the -300x256 file, drawn 300 by 256.
	const upload = "https://example.org/wp-content/uploads/2015/04/storefront.png";
	const medium = "https://example.org/wp-content/uploads/2015/04/storefront-300x256.png";
	const local = "/_emdash/api/media/file/01KSTOREFRONT.png";
	const content = (src: string) =>
		`<p><img class="alignleft wp-image-15 size-medium" src="${src}" alt="" width="300" height="256" />Words beside the picture.</p>`;
	const convert = (html: string): PortableTextBlock[] =>
		gutenbergToPortableText(html) as PortableTextBlock[];

	it("keeps it where the map names the upload, which the size's URL is matched to", () => {
		const blocks = convert(content(medium));
		const urlMap = { [upload]: local };

		expect(rewritePortableTextUrls(blocks, urlMap, buildBaseUrlMap(urlMap))).toEqual({
			changed: true,
			urlsRewritten: 1,
		});
		// the file is the upload itself, however large; the size is the one WordPress drew
		expect(blocks[0]).toMatchObject({
			_type: "image",
			asset: { _ref: local, url: local },
			alignment: "left",
			displayWidth: 300,
			displayHeight: 256,
		});
	});

	it("keeps it where the map names the size itself (another spelling of it, mapped onto the upload)", () => {
		const http = medium.replace("https:", "http:");
		const blocks = convert(content(http));
		const urlMap = { [upload]: local, [http]: local };

		rewritePortableTextUrls(blocks, urlMap, buildBaseUrlMap(urlMap));
		expect(blocks[0]).toMatchObject({
			asset: { url: local },
			displayWidth: 300,
			displayHeight: 256,
		});
	});
});

describe("a URL map key that carries a query stands for that URL alone", () => {
	// An attachment's shortlink: WordPress answers it for every upload, and an
	// image linked to its attachment page can keep it. Its base is the home page.
	const shortlink = "https://example.com/?attachment_id=7";
	const file = "/_emdash/api/media/file/01KPHOTO.jpg";
	const upload = "https://example.com/wp-content/uploads/2026/01/photo.jpg";
	const uploadImported = "/_emdash/api/media/file/01KUPLOAD.jpg";
	const urlMap = { [shortlink]: file, [upload]: uploadImported };
	const baseMap = buildBaseUrlMap(urlMap);

	it("matches exactly, and never the home page, another shortlink or another attachment", () => {
		expect(findMatchingUrl(shortlink, urlMap, baseMap)).toBe(file);
		for (const other of [
			"https://example.com/",
			"https://example.com/?p=10",
			"https://example.com/?attachment_id=71",
		]) {
			expect(findMatchingUrl(other, urlMap, baseMap), other).toBeNull();
		}
		// A key without a query still matches its variants by its base.
		expect(findMatchingUrl(`${upload}?w=300`, urlMap, baseMap)).toBe(uploadImported);
	});

	it("rewrites the link to it in converted content, and no other link", () => {
		const blocks = gutenbergToPortableText(
			`<p><a href="${shortlink}">the photo</a>, <a href="https://example.com/">home</a> and <a href="https://example.com/?p=10">a post</a></p>`,
		) as PortableTextBlock[];

		expect(rewritePortableTextUrls(blocks, urlMap, baseMap)).toEqual({
			changed: true,
			urlsRewritten: 1,
		});
		expect(blocks[0]?.markDefs).toEqual([
			expect.objectContaining({ href: file }),
			expect.objectContaining({ href: "https://example.com/" }),
			expect.objectContaining({ href: "https://example.com/?p=10" }),
		]);
	});

	it("in a string, only where the URL ends with it", () => {
		const value =
			`<a href="${shortlink}">a</a> <a href="https://example.com/?attachment_id=71">b</a> ` +
			`<a href="https://example.com/">home</a> ${shortlink}.`;

		expect(rewriteStringUrls(value, urlMap, baseMap)).toEqual({
			newValue:
				`<a href="${file}">a</a> <a href="https://example.com/?attachment_id=71">b</a> ` +
				`<a href="https://example.com/">home</a> ${file}.`,
			changed: true,
			urlsRewritten: 1,
		});
	});
});

/**
 * A page drawn in its own layout (Embark's layout-pt.ts) keeps the class the page drew on
 * each link in its skeleton, by the link's href (templates/blog-cloudflare
 * src/utils/wp-skeleton.ts `linkClasses`). The rewrite moves the href of a link to an
 * imported file, so it moves the key that names that href too, or the link loses its class.
 */
describe("a layout's link classes follow the links the rewrite moves", () => {
	const pdf = "https://example.com/wp-content/uploads/2026/01/cv.pdf";
	const moved = "/_emdash/api/media/file/01CV.pdf";
	const other = "https://elsewhere.example/";
	const exact = { [pdf]: moved };
	const base = buildBaseUrlMap(exact);
	const carrier = (linkClasses: Record<string, string>) => ({
		_type: "layout-section",
		_key: "ls-0",
		skeleton: { wraps: [], widgets: { l0: { wraps: [], linkClasses } }, added: { wraps: [] } },
	});

	it("rewrites the key of a moved link's class, with the link's own href, and leaves any other key", () => {
		const blocks: PortableTextBlock[] = [
			carrier({ [pdf]: "cv-button", [other]: "pill" }),
			{
				_type: "block",
				_key: "el-l0",
				children: [],
				markDefs: [{ _type: "link", _key: "a", href: pdf }],
			},
		];
		expect(rewritePortableTextUrls(blocks, exact, base)).toEqual({
			changed: true,
			urlsRewritten: 2,
		});
		const skeleton = blocks[0]!.skeleton as {
			widgets: { l0: { linkClasses: Record<string, string> } };
		};
		expect(skeleton.widgets.l0.linkClasses).toEqual({ [moved]: "cv-button", [other]: "pill" });
		expect(blocks[1]!.markDefs).toEqual([expect.objectContaining({ href: moved })]);
	});

	it("reports a layout whose only moved URL is a class's key as changed, so it is written", () => {
		const blocks: PortableTextBlock[] = [carrier({ [pdf]: "cv-button" })];
		expect(rewritePortableTextUrls(blocks, exact, base)).toEqual({
			changed: true,
			urlsRewritten: 1,
		});
	});

	it("names no class for a moved key that meets another key of a different class, as the import names none for links that disagree", () => {
		const blocks: PortableTextBlock[] = [carrier({ [pdf]: "cv-button", [moved]: "pill" })];
		rewritePortableTextUrls(blocks, exact, base);
		const skeleton = blocks[0]!.skeleton as {
			widgets: { l0: { linkClasses: Record<string, string> } };
		};
		expect(skeleton.widgets.l0.linkClasses).toEqual({});
	});

	it("leaves a skeleton it cannot read, and one with no link classes, as they are", () => {
		const odd = [
			{ _type: "layout-section", _key: "a", skeleton: { widgets: { l0: { linkClasses: [pdf] } } } },
			{ _type: "layout-section", _key: "b", skeleton: { widgets: "x" } },
			{ _type: "layout-section", _key: "c", skeleton: { wraps: [] } },
		] as PortableTextBlock[];
		const before = JSON.stringify(odd);
		expect(rewritePortableTextUrls(odd, exact, base)).toEqual({ changed: false, urlsRewritten: 0 });
		expect(JSON.stringify(odd)).toBe(before);
	});
});

describe("a layout's link titles follow the links the rewrite moves", () => {
	const pdf = "https://example.com/wp-content/uploads/2026/01/cv.pdf";
	const moved = "/_emdash/api/media/file/01CV.pdf";
	const other = "https://elsewhere.example/";
	const exact = { [pdf]: moved };
	const base = buildBaseUrlMap(exact);
	const carrier = (widget: Record<string, unknown>) => ({
		_type: "layout-section",
		_key: "ls-0",
		skeleton: { wraps: [], widgets: { l0: { wraps: [], ...widget } }, added: { wraps: [] } },
	});
	const widgetOf = (b: PortableTextBlock) =>
		(b.skeleton as { widgets: { l0: Record<string, unknown> } }).widgets.l0;

	it("rewrites the key of a moved link's title, as it does its class, and leaves any other key", () => {
		const blocks: PortableTextBlock[] = [
			carrier({
				linkClasses: { [pdf]: "cv-button" },
				linkTitles: { [pdf]: "My CV", [other]: "Elsewhere" },
			}),
		];
		expect(rewritePortableTextUrls(blocks, exact, base)).toEqual({
			changed: true,
			urlsRewritten: 2,
		});
		expect(widgetOf(blocks[0]!).linkTitles).toEqual({ [moved]: "My CV", [other]: "Elsewhere" });
		expect(widgetOf(blocks[0]!).linkClasses).toEqual({ [moved]: "cv-button" });
	});

	it("names no title for a moved key that meets another key of a different title", () => {
		const blocks: PortableTextBlock[] = [
			carrier({ linkTitles: { [pdf]: "My CV", [moved]: "Another" } }),
		];
		rewritePortableTextUrls(blocks, exact, base);
		expect(widgetOf(blocks[0]!).linkTitles).toEqual({});
	});
});
