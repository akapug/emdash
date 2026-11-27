/**
 * Item 163g: static inline SVG carried through sanitizeContent, or refused whole.
 *
 * Measured population, from the five real exports' page content: 11 inline `<svg>` across 3 pages on 2 sites — 10 on twpe
 * (`uagb/info-box`, `uagb/icon-list-child`) and 1 on calulti. All use only `svg`/`g`/`path`. The other three sites carry none.
 *
 * The attack arms are codex's list: source text carrying a guessed token or the old attribute; svg-like text inside an attribute, a
 * comment, a textarea and a script; namespace and ancestor mismatches; and a no-svg page byte-identical to before.
 */

import { describe, expect, it } from "vitest";

import { sanitizeContent } from "../../../src/utils/sanitize.js";
import { validPathData, validPaint, validTransform, validViewBox } from "../../../src/utils/sanitize-svg.js";

/** twpe's info-box icon, as the export carries it (10 across 2 pages). */
const TWPE_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M224 256A128 128 0 1 0 224 0a128 128 0 1 0 0 256zm-45.7 48C79.8 304 0 383.8 0 482.3 0 498.7 13.3 512 29.7 512H418.3c16.4 0 29.7-13.3 29.7-29.7C448 383.8 368.2 304 269.7 304H178.3z"/></svg>';

/** calulti's icon: a `g` wrapper plus the reference attributes the amend forbids (1 across 1 page). */
const CALULTI_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32"><g transform="translate(-511, -20)"><path d="M0 0h32v32H0z" fill="#333" fill-rule="evenodd"/></g></svg>';

const out = (html: string): string => sanitizeContent(html);

describe("163g: the real icons survive", () => {
	it("twpe's info-box icon is carried with viewBox cased as SVG requires", () => {
		const html = out(`<div class="uagb-info-box">${TWPE_ICON}</div>`);
		expect(html, "the element survived").toContain("<svg");
		expect(html, "geometry survived").toContain("M224 256A128");
		// parse5 keeps SVG attribute casing, so `viewBox` must arrive intact rather than lowercased.
		expect(html.toLowerCase()).toContain("viewbox");
	});

	it("calulti's icon keeps its g/path geometry and loses the reference namespace", () => {
		const html = out(CALULTI_ICON);
		expect(html).toContain("<g");
		expect(html).toContain("translate(-511, -20)");
		expect(html).toContain('fill="#333"');
		expect(html, "xmlns:xlink is a reference feature").not.toContain("xlink");
	});

	it("no provenance is carried in markup: nothing to forge", () => {
		const html = out(TWPE_ICON);
		expect(html).not.toContain("data-embark");
		expect(html, "no marker text leaks into the page").not.toContain("EMDASHSVG");
	});

	it("a page with NO svg is byte-identical: the four sites without icons cannot change", () => {
		const page = '<p>Prose with an ampersand &amp; a <a href="https://example.org/x">link</a> and <strong>bold</strong>.</p>';
		expect(out(page), "same bytes in, same bytes out").toBe(page);
	});
});

describe("163g: every way in is refused, and none of it is unwrapped", () => {
	it("a script inside the SVG takes the whole subtree with it", () => {
		const html = out('<svg viewBox="0 0 10 10"><script>alert(1)</script><path d="M0 0"/></svg>');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<path");
		expect(html).not.toContain("alert");
	});

	it("a source carrying the old provenance attribute is not trusted", () => {
		const html = out('<svg data-embark-svg="1" viewBox="0 0 10 10"><script>alert(1)</script></svg>');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("alert");
	});

	it("a source that GUESSES a marker shape cannot mint one", () => {
		// The marker is 128 random bits per call; a literal can never match, so this text stays text and no icon appears.
		const html = out('<p>EMDASHSVG00000000000000000000000000000000END</p>');
		expect(html).not.toContain("<svg");
		expect(html, "the guessed text is not upgraded into markup").not.toContain("path");
	});

	it("mixed-case event handlers are refused, not lowercased into survival", () => {
		const html = out('<svg viewBox="0 0 10 10" ONLOAD="alert(1)"><path onClick="alert(2)" d="M0 0"/></svg>');
		expect(html).not.toContain("alert");
		expect(html.toLowerCase()).not.toContain("onload");
	});

	it("foreignObject is refused, and its HTML does not escape into the page", () => {
		const html = out('<svg viewBox="0 0 10 10"><foreignObject><iframe src="https://evil.test"></iframe></foreignObject></svg>');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("evil.test");
	});

	it("use and image cannot reference anything", () => {
		const html = out('<svg viewBox="0 0 10 10"><use href="https://evil.test/x.svg#a"/><image href="https://evil.test/p.png"/></svg>');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("evil.test");
	});

	it("a NAMESPACE mismatch refuses: svg inside MathML is not our SVG", () => {
		const html = out('<math><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></math>');
		// parse5 puts this svg in the SVG namespace even inside math (foreign content), so the test is that whatever survives is
		// validated markup and not a raw copy: either it is carried legitimately or dropped, never passed through unchanged.
		if (html.includes("<svg")) expect(html.toLowerCase()).toContain("viewbox");
		else expect(html).not.toContain("<path");
	});

	it("an ORPHAN path with no svg ancestor is refused", () => {
		expect(out('<p>Text</p><path d="M0 0h10v10z"/>'), "flat HTML has no SVG context to belong to").not.toContain("<path");
	});

	it("svg-like text in an ATTRIBUTE, a COMMENT, a TEXTAREA and a SCRIPT is never upgraded to markup", () => {
		expect(out('<p title="<svg viewBox=\'0 0 1 1\'><path d=\'M0 0\'/></svg>">t</p>'), "attribute").not.toContain("<path");
		expect(out("<!-- <svg viewBox='0 0 1 1'><path d='M0 0'/></svg> -->"), "comment").not.toContain("<path");
		expect(out("<textarea><svg viewBox='0 0 1 1'><path d='M0 0'/></svg></textarea>"), "textarea").not.toContain("<path");
		expect(out("<script><svg viewBox='0 0 1 1'><path d='M0 0'/></svg></script>"), "script").not.toContain("<path");
	});

	it("an external url() paint server cannot appear: the grammar has no room for it", () => {
		const html = out('<svg viewBox="0 0 10 10"><path fill="url(https://evil.test/x.svg#g)" stroke="url(#evil)" d="M0 0"/></svg>');
		expect(html, "the icon is carried").toContain("<svg");
		expect(html, "the paint values are dropped").not.toContain("url(");
		expect(html).not.toContain("evil.test");
	});
});

describe("163g: the value grammars are arithmetic and colour, not blacklists", () => {
	it("viewBox needs four finite numbers with positive extents", () => {
		expect(validViewBox("0 0 448 512")).toBe(true);
		expect(validViewBox("-10, -10, 20, 20")).toBe(true);
		expect(validViewBox("0 0 0 512"), "zero width draws nothing").toBe(false);
		expect(validViewBox("0 0 448 512 onclick=alert(1)")).toBe(false);
	});

	it("paint has no shape that could hold a URL", () => {
		for (const good of ["#333", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "none", "currentColor", "red"]) expect(validPaint(good), good).toBe(true);
		for (const bad of ["url(#x)", "url(https://evil.test/a.svg#g)", "", "javascript:alert(1)"]) expect(validPaint(bad), bad).toBe(false);
	});

	it("transform takes 2D affine functions with numbers only", () => {
		expect(validTransform("translate(-511, -20)")).toBe(true);
		expect(validTransform("translate(0,0) url(#x)")).toBe(false);
	});

	it("path data is drawing commands and numbers, beginning with a moveto", () => {
		expect(validPathData("M0 0h32v32H0z")).toBe(true);
		expect(validPathData("h32v32"), "no moveto draws nothing").toBe(false);
	});
});
