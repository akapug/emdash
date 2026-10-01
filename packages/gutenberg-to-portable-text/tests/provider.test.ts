import { describe, expect, it } from "vitest";

import { detectProvider } from "../src/provider.js";

describe("detectProvider reads a URL's host, never a substring of it", () => {
	it.each([
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		["https://youtu.be/dQw4w9WgXcQ", "youtube"],
		["https://vimeo.com/76979871", "vimeo"],
		["https://x.com/someone/status/1", "twitter"],
		["https://mobile.twitter.com/someone/status/1", "twitter"],
		["https://open.spotify.com/episode/abc", "spotify"],
		["https://gist.github.com/someone/abc", "gist"],
		["youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		["//www.youtube.com/embed/dQw4w9WgXcQ", "youtube"],
	])("names %s %s", (url, provider) => expect(detectProvider(url)).toBe(provider));

	// Each of these only CONTAINS a provider's domain: "x.com" in dropbox.com,
	// box.com, wix.com and mapbox.com; "vimeo.com" in a path; "youtube.com" in a query.
	it.each([
		"https://www.dropbox.com/s/abc/file.pdf",
		"https://app.box.com/s/abc",
		"https://example.wix.com/site",
		"https://api.mapbox.com/styles/v1",
		"https://example.org/notes/vimeo.com-tips",
		"https://example.org/?ref=youtube.com",
	])("names no provider for %s", (url) => expect(detectProvider(url)).toBeUndefined());

	it("names none for what is no URL", () => {
		expect(detectProvider("")).toBeUndefined();
		expect(detectProvider("not a url at all")).toBeUndefined();
	});
});
