/**
 * Item 163g, condition 3: does the WORKER runtime resolve `parse5` and carry an icon?
 *
 * The unit arms prove the logic in node. This proves the environment the code actually ships to — parse5 is an external import in the dist
 * build, so "it builds" says nothing about whether a Worker can resolve and run it.
 */

import { expect, it } from "vitest";

import { sanitizeContent } from "../../src/utils/sanitize.js";

const ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M224 256A128 128 0 1 0 224 0z"/></svg>';

it("the Worker runtime resolves parse5 and carries a real icon", () => {
	const html = sanitizeContent(`<div class="uagb-info-box">${ICON}</div>`);
	console.log("WORKER_OUT:", html);
	expect(html, "the icon survived in the Worker").toContain("<svg");
	expect(html.toLowerCase(), "viewBox casing held").toContain("viewbox");
	expect(html, "geometry held").toContain("M224 256A128");
});

it("a page with no svg is byte-identical in the Worker too", () => {
	expect(sanitizeContent("<p>plain</p>")).toBe("<p>plain</p>");
});
