/**
 * emb/97 fork half — the sign-up marker in imported HTML.
 *
 * The importer writes `<div data-embark-subscribe="1"></div>` where a
 * `[newsletter]`-family shortcode stood. The template's htmlBlock override
 * splits the HTML there and draws the plugin's own form between the pieces.
 * These arms pin the split, which is the part that can go wrong silently.
 */
import { describe, expect, it } from "vitest";

import { hasSubscribeMarker, splitAtSubscribeMarkers } from "../src/marker.js";

const MARKER = '<div data-embark-subscribe="1"></div>';

describe("emb/97: the sign-up marker", () => {
	it("finds the marker the importer writes", () => {
		expect(hasSubscribeMarker(`<p>a</p>${MARKER}<p>b</p>`)).toBe(true);
	});

	it("CONTROL: a page with no marker says so", () => {
		expect(hasSubscribeMarker("<p>just words</p>")).toBe(false);
	});

	it("SPLITS IN PLACE: the text either side keeps its order", () => {
		const pieces = splitAtSubscribeMarkers(`<p>Before</p>${MARKER}<p>After</p>`);
		expect(pieces).toHaveLength(2);
		expect(pieces[0]).toContain("Before");
		expect(pieces[1]).toContain("After");
		// The marker itself is gone: it was a record, and now it is the form.
		expect(pieces.join("")).not.toContain("data-embark-subscribe");
	});

	it("two markers make three pieces", () => {
		const pieces = splitAtSubscribeMarkers(`<p>a</p>${MARKER}<p>b</p>${MARKER}<p>c</p>`);
		expect(pieces).toHaveLength(3);
	});

	it("CONTROL: no marker is one piece, unchanged", () => {
		const html = "<p>just words</p>";
		expect(splitAtSubscribeMarkers(html)).toEqual([html]);
	});

	it("the marker's attribute order and spacing are the importer's, not a guess", () => {
		// The importer writes exactly this. A looser match would also catch a
		// customer's own div that happens to carry the attribute.
		expect(hasSubscribeMarker('<div  data-embark-subscribe="1" ></div>')).toBe(true);
		expect(hasSubscribeMarker('<div data-embark-subscribe="2"></div>')).toBe(false);
	});
});
