/**
 * A post copied from a rendered WordPress.com page carries the page's own
 * furniture: Jetpack's Likes button, an iframe from `widgets.wp.com/likes/`
 * that works only on WordPress.com. It is no content of the post. Since
 * classic iframes are kept, it was kept too, and EmDash drew it as a link
 * ("Open the embedded content"). It is dropped: the post draws what it
 * draws as if the iframe were absent. A WordPress.com host that serves
 * content is not chrome, and is kept like any other iframe.
 */

import { describe, expect, it } from "vitest";

import { isPlatformChrome } from "../src/iframe.js";
import { gutenbergToPortableText } from "../src/index.js";
import type { PortableTextBlock } from "../src/types.js";

const LIKES =
	"https://widgets.wp.com/likes/#blog_id=1234&amp;post_id=5&amp;origin=example.wordpress.com&amp;obj_id=1234-5-abc";
const likes = (src = LIKES) =>
	`<iframe class="post-likes-widget jetpack-likes-widget" src="${src}" name="like-post-frame-1234-5-abc" width="100%" height="55px" frameborder="0"></iframe>`;

const keys = () => {
	let n = 0;
	return () => `k${++n}`;
};
const convert = (html: string) => gutenbergToPortableText(html, { keyGenerator: keys() });
const kinds = (blocks: PortableTextBlock[]) => blocks.map((b) => b._type);
/** Each block's type, and a text block's style and text: what the reader sees, not where a span ends. */
const drawn = (blocks: PortableTextBlock[]) =>
	blocks.map((b) =>
		b._type === "block" ? `${b.style}: ${b.children.map((c) => c.text).join("")}` : b._type,
	);

/** The page's sharing block as a copied WordPress.com post carries it. */
const SHARING = (frame: string) =>
	'<p>The post.</p>\n<div class="sharedaddy sd-sharing-enabled"><div class="robots-nocontent sd-block sd-social">' +
	'<h3 class="sd-title">Share this:</h3><div class="sd-content"><ul><li class="share-end"></li></ul></div></div></div>\n' +
	'<div id="like-post-wrapper-1234-5-abc" class="sharedaddy sd-block sd-like jetpack-likes-widget-wrapper jetpack-likes-widget-unloaded">\n' +
	'<div class="likes-widget-placeholder post-likes-widget-placeholder"><span class="loading">Loading...</span></div>\n' +
	`${frame}\n\n</div>\n<p>After.</p>`;

describe("WordPress.com platform chrome is dropped, never kept or linked", () => {
	it.each([
		["the Likes button as a copied post carries it", SHARING(likes())],
		["on a line of its own", `<p>Before.</p>\n${likes()}\n<p>After.</p>`],
		["inside a paragraph", `<p>Before ${likes()} after.</p>`],
		["inside a div", `<div>Before ${likes()} after.</div>`],
		["inside a figure", `<figure>${likes()}<figcaption>Caption</figcaption></figure>`],
		["on the page's scheme", SHARING(likes(LIKES.replace("https:", "")))],
		["over http", SHARING(likes(LIKES.replace("https:", "http:")))],
		[
			"the Likes master frame",
			SHARING(likes("https://widgets.wp.com/likes/master.html?ver=20240101#ver=20240101")),
		],
		[
			"with its host in capitals",
			SHARING(likes(LIKES.replace("widgets.wp.com", "WIDGETS.WP.COM"))),
		],
		["written without its end tag", `<p>Before ${likes().replace("></iframe>", " />")} after.</p>`],
	])("%s: draws what the post draws without the iframe", (_, html) => {
		const blocks = convert(html);
		expect(kinds(blocks)).not.toContain("htmlBlock");
		expect(kinds(blocks)).not.toContain("embed");
		expect(JSON.stringify(blocks)).not.toContain("widgets.wp.com");
		const without = html.replace(/<iframe\b[^>]*?(?:\/>|><\/iframe>)/i, "");
		expect(drawn(blocks)).toEqual(drawn(convert(without)));
	});

	it("drops the chrome and keeps a real embed beside it", () => {
		const blocks = convert(
			`<p>Watch:</p>\n<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>\n${likes()}\n<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>`,
		);
		expect(kinds(blocks)).toEqual(["block", "embed", "htmlBlock"]);
		expect(blocks[2]).toMatchObject({ html: expect.stringContaining("www.google.com/maps/embed") });
	});
});

describe("a WordPress.com host that is not measured chrome is kept like any other iframe", () => {
	it.each([
		["VideoPress", "https://videopress.com/embed/AbCdEfGh"],
		["a WordPress.com video", "https://video.wordpress.com/embed/AbCdEfGh"],
		["a WordPress.com media embed", "https://example.wordpress.com/embed/post/"],
		["another widgets.wp.com path", "https://widgets.wp.com/other/"],
		["a path that only starts like Likes", "https://widgets.wp.com/likesx/"],
		["a host that only starts like the widget host", "https://widgets.wp.com.example/likes/"],
		["a host under the widget host", "https://a.widgets.wp.com/likes/"],
	])("%s", (_, src) => {
		expect(isPlatformChrome(src)).toBe(false);
		const blocks = convert(`<p>Before.</p>\n<iframe src="${src}"></iframe>`);
		expect(blocks[1]).toMatchObject({ _type: "htmlBlock", html: `<iframe src="${src}"></iframe>` });
	});
});

describe("isPlatformChrome", () => {
	it.each([
		["https://widgets.wp.com/likes/#blog_id=1", true],
		["https://widgets.wp.com/likes", true],
		["https://widgets.wp.com/likes/index.html?ver=1", true],
		["https://widgets.wp.com\\likes\\", true],
		["not a url", false],
		["", false],
	])("%s -> %s", (src, chrome) => {
		expect(isPlatformChrome(src)).toBe(chrome);
	});
});
