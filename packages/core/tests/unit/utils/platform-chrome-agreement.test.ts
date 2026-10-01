import { describe, expect, it, vi } from "vitest";

// The converter's predicate, by path: it is not exported from the package index.
import { isPlatformChrome as converterSays } from "../../../../gutenberg-to-portable-text/src/iframe.js";
import { isPlatformChrome as coreSays } from "../../../src/utils/iframe-hosts.js";
import { sanitizeContent } from "../../../src/utils/sanitize.js";

// WordPress.com platform chrome is listed three times: the converter
// (gutenberg-to-portable-text src/iframe.ts), the renderer (core
// src/utils/iframe-hosts.ts) and Embark's import report (packages/host
// src/fixups/source.ts `platformChromeOf`). This table is copied verbatim into
// Embark's packages/host/test/fixups/iframes.test.ts; a change to one list or
// one table that the others do not take fails here or there.
const CHROME_TABLE: ReadonlyArray<readonly [src: string, chrome: boolean]> = [
	["https://widgets.wp.com/likes/", true],
	["//widgets.wp.com/likes/", true],
	["http://widgets.wp.com/likes/", true],
	["https://WIDGETS.WP.COM/likes/", true],
	["https://widgets.wp.com:8443/likes/", true],
	["https://widgets.wp.com/likes/master.html?ver=20240101", true],
	["https://widgets.wp.com/likes/#blog_id=1&post_id=5&origin=example.wordpress.com", true],
	["https://widgets.wp.com.evil.test/likes/", false],
	["https://widgets.wp.com@evil.test/likes/", false],
	["https://a.widgets.wp.com/likes/", false],
	["https://widgets.wp.com./likes/", false],
	["https://widgets.wp.com/%6cikes/", false],
	["https://widgets.wp.com/Likes/", false],
	["https://widgets.wp.com/likesx", false],
	["https://widgets.wp.com/likes/../videopress/x", false],
	["https://widgets.wp.com/videopress/likes/", false],
	["https://videopress.com/embed/AbCdEfGh", false],
	["https://video.wordpress.com/embed/AbCdEfGh", false],
	["https://example.wordpress.com/embed/post/", false],
];

describe("WordPress.com platform chrome: the converter and the renderer agree", () => {
	it.each(CHROME_TABLE)("%s -> %s", (src, chrome) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(converterSays(src)).toBe(chrome);
		expect(coreSays(new URL(src.startsWith("//") ? `https:${src}` : src))).toBe(chrome);
		// What the renderer draws of it: nothing for chrome, a link to it otherwise
		const drawn = sanitizeContent(`<iframe src="${src}"></iframe>`);
		expect(drawn === "").toBe(chrome);
		vi.restoreAllMocks();
	});
});
