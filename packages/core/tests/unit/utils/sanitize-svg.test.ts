/**
 * Item 163g: static inline SVG carried through sanitizeContent, or refused whole.
 *
 * Measured before building, on the five real exports (468 published posts and pages): 11 inline `<svg>` across 3 pages on 2 sites —
 * 10 on twpe (`svg`/`path` only) and 1 on calulti (`svg`/`g`/`path`). The fixtures below are those two shapes, verbatim from the
 * exports, plus one arm per way the allowlist can be attacked.
 */

import { describe, expect, it } from "vitest";

import { sanitizeContent } from "../../../src/utils/sanitize.js";
import { validPathData, validPaint, validTransform, validViewBox } from "../../../src/utils/sanitize-svg.js";

/** twpe's `uagb/info-box` icon, as the export carries it. */
const TWPE_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M224 256A128 128 0 1 0 224 0a128 128 0 1 0 0 256zm-45.7 48C79.8 304 0 383.8 0 482.3 0 498.7 13.3 512 29.7 512H418.3c16.4 0 29.7-13.3 29.7-29.7C448 383.8 368.2 304 269.7 304H178.3z"/></svg>';

/** calulti's single icon, with its `g` wrapper and the reference attributes the amend forbids. */
const CALULTI_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32"><g transform="translate(-511, -20)"><path d="M0 0h32v32H0z" fill="#333" fill-rule="evenodd"/></g></svg>';

const out = (html: string): string => sanitizeContent(html);

describe("163g: the real icons survive with their casing intact", () => {
	it("twpe's info-box icon is carried, viewBox cased as SVG requires", () => {
		const html = out(`<div class="uagb-info-box">${TWPE_ICON}</div>`);
		expect(html, "the element survived").toContain("<svg");
		expect(html, "viewBox casing restored after the allowlist lowercased it").toContain('viewBox="0 0 448 512"');
		expect(html).toContain("<path");
		expect(html).toContain("M224 256A128");
	});

	it("calulti's icon keeps its g/path geometry and loses the reference namespace", () => {
		const html = out(CALULTI_ICON);
		expect(html).toContain("<g");
		expect(html).toContain('transform="translate(-511, -20)"');
		expect(html).toContain('fill="#333"');
		expect(html, "xmlns:xlink is a reference feature the amend forbids").not.toContain("xlink");
		expect(html, "no xmlns is required by the amend").not.toContain("xmlns");
	});

	it("the rebuild's own marker never reaches the customer's markup", () => {
		expect(out(TWPE_ICON)).not.toContain("data-embark-svg");
	});
});

describe("163g: every way in is refused WHOLE, never unwrapped", () => {
	it("a script inside the SVG takes the whole subtree with it", () => {
		const html = out('<svg viewBox="0 0 10 10"><script>alert(1)</script><path d="M0 0"/></svg>');
		expect(html, "no svg, and no orphaned path left behind").not.toContain("<svg");
		expect(html).not.toContain("<path");
		expect(html).not.toContain("alert");
	});

	it("mixed-case event handlers are refused, not lowercased into survival", () => {
		const html = out('<svg viewBox="0 0 10 10" ONLOAD="alert(1)"><path onClick="alert(2)" d="M0 0"/></svg>');
		expect(html).not.toContain("alert");
		expect(html.toLowerCase()).not.toContain("onload");
		expect(html.toLowerCase()).not.toContain("onclick");
	});

	it("foreignObject is refused, and its HTML does not escape into the page", () => {
		const html = out('<svg viewBox="0 0 10 10"><foreignObject><iframe src="https://evil.test"></iframe></foreignObject></svg>');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("evil.test");
	});

	it("use and image cannot reference anything", () => {
		const html = out(
			'<svg viewBox="0 0 10 10"><use href="https://evil.test/x.svg#a"/><use xlink:href="data:image/svg+xml,x"/><image href="https://evil.test/p.png"/></svg>',
		);
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("evil.test");
		expect(html).not.toContain("data:image");
	});

	it("SMIL animation is refused whole", () => {
		const html = out(
			'<svg viewBox="0 0 10 10"><animate onbegin="alert(1)" attributeName="href" values="javascript:alert(1)"/><set attributeName="onmouseover" to="alert(1)"/></svg>',
		);
		expect(html).not.toContain("<svg");
		expect(html.toLowerCase()).not.toContain("onbegin");
	});

	it("an external url() paint server cannot appear: the paint grammar has no room for it", () => {
		const html = out('<svg viewBox="0 0 10 10"><path fill="url(https://evil.test/x.svg#g)" stroke="url(#evil)" d="M0 0"/></svg>');
		expect(html, "the icon is carried; the paint values are dropped").toContain("<path");
		expect(html).not.toContain("url(");
		expect(html).not.toContain("evil.test");
	});

	it("a style element inside the SVG is refused whole", () => {
		const html = out('<svg viewBox="0 0 10 10"><style>body{background:url(https://evil.test)}</style></svg>');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("evil.test");
	});

	it("a raw <path> in HTML is not kept: it has no SVG context to belong to", () => {
		const html = out('<p>Before</p><path d="M0 0h10v10z"/><p>After</p>');
		expect(html).not.toContain("<path");
		expect(html, "the surrounding prose is untouched").toContain("Before");
	});

	it("an unclosed <svg> is stripped by the pass below, not guessed at here", () => {
		const html = out('<p>Before</p><svg viewBox="0 0 10 10"><path d="M0 0"/>');
		expect(html).not.toContain("<svg");
		expect(html).toContain("Before");
	});
});

describe("163g: the value grammars are arithmetic, not blacklists", () => {
	it("viewBox needs four finite numbers with positive extents", () => {
		expect(validViewBox("0 0 448 512")).toBe(true);
		expect(validViewBox("-10, -10, 20, 20")).toBe(true);
		expect(validViewBox("0 0 0 512"), "zero width draws nothing").toBe(false);
		expect(validViewBox("0 0 -5 512")).toBe(false);
		expect(validViewBox("0 0 448")).toBe(false);
		expect(validViewBox("0 0 448 512 onclick=alert(1)")).toBe(false);
	});

	it("paint accepts colours and has no shape that could hold a URL", () => {
		for (const good of ["#333", "#33333380", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "none", "currentColor", "red"]) {
			expect(validPaint(good), good).toBe(true);
		}
		for (const bad of ["url(#x)", "url(https://evil.test/a.svg#g)", "expression(alert(1))", "", "javascript:alert(1)"]) {
			expect(validPaint(bad), bad).toBe(false);
		}
	});

	it("transform takes 2D affine functions with numbers only", () => {
		expect(validTransform("translate(-511, -20)")).toBe(true);
		expect(validTransform("matrix(1,0,0,1,0,0) rotate(45)")).toBe(true);
		expect(validTransform("translate(0,0) url(#x)")).toBe(false);
		expect(validTransform("rotate(alert(1))")).toBe(false);
	});

	it("path data is drawing commands and numbers, and must begin with a moveto", () => {
		expect(validPathData("M0 0h32v32H0z")).toBe(true);
		expect(validPathData("m 10 10 l 5 5 z")).toBe(true);
		expect(validPathData("h32v32")).toBe(false);
		expect(validPathData('M0 0" onload="alert(1)')).toBe(false);
	});
});
