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
		expect(html, "no slot marker leaks into the page").not.toContain("data-embark-svg-slot");
	});

	// CODEX'S THIRD FINDING, as arms. An earlier version rebuilt ordinary HTML by hand and returned "" for every childless element, so a
	// page carrying an icon lost its images and form controls. Ordinary HTML must now be parse5's own serialization, untouched.
	it("childless ordinary elements SURVIVE beside an icon: img and br are not collateral", () => {
		const markup = `<p>Before</p><img src="/_emdash/api/media/file/a.jpg" alt="A"><br>`;
		const withIcon = out(`${markup}${TWPE_ICON}`);
		const without = out(markup);
		expect(withIcon, "the icon is carried").toContain("<svg");
		// The comparison is the point: the SAME ordinary markup must come through identically whether or not an icon rides along.
		for (const fragment of ['src="/_emdash/api/media/file/a.jpg"', 'alt="A"', "<br"]) {
			expect(withIcon, `with an icon: ${fragment}`).toContain(fragment);
			expect(without, `without an icon: ${fragment}`).toContain(fragment);
		}
		// A control OUTSIDE an approved newsletter form is dropped by the existing policy in both cases — measured, not assumed, and
		// deliberately not asserted here as if this change were responsible for it.
		expect(withIcon, "the input is dropped by the pre-existing control policy").not.toContain("<input");
		expect(without, "and identically without an icon").not.toContain("<input");
	});

	it("a refused icon beside ordinary content leaves the ordinary content whole", () => {
		const html = out('<p>Keep me</p><img src="/a.jpg" alt="x"><svg viewBox="0 0 1 1"><script>alert(1)</script></svg>');
		expect(html).not.toContain("<svg");
		expect(html, "the paragraph is untouched").toContain("Keep me");
		expect(html, "and the image with it").toContain('src="/a.jpg"');
	});

	// CODEX'S THIRD HOLD: the parser merges a slot with adjacent prose or another slot into ONE text node. Requiring the whole node to be
	// a marker left the marker visible as text whenever an icon stood beside prose. These are the positive cases it asked for.
	it("an icon with PROSE ON BOTH SIDES keeps the prose and draws the icon, with no marker text", () => {
		const html = out(`<p>before ${TWPE_ICON} after</p>`);
		expect(html, "the icon is drawn").toContain("<svg");
		expect(html, "the prose before survives").toContain("before");
		expect(html, "and after").toContain("after");
		expect(html, "no marker leaks as visible text").not.toContain("EMDASHSVG");
	});

	it("TWO ADJACENT icons are both drawn, and neither marker leaks", () => {
		const html = out(`<p>${TWPE_ICON}${TWPE_ICON}</p>`);
		expect(html.match(/<svg/g)?.length, "both icons").toBe(2);
		expect(html.match(/<path/g)?.length, "with both geometries").toBe(2);
		expect(html).not.toContain("EMDASHSVG");
	});

	it("an icon between two other icons and prose: three drawn, prose intact, no markers", () => {
		const html = out(`<p>a ${TWPE_ICON} b ${CALULTI_ICON} c ${TWPE_ICON} d</p>`);
		expect(html.match(/<svg/g)?.length, "all three icons").toBe(3);
		for (const word of ["a", "b", "c", "d"]) expect(html, `prose ${word}`).toContain(word);
		expect(html).not.toContain("EMDASHSVG");
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

	it("a NAMESPACE mismatch REFUSES: svg inside MathML is not an approved position", () => {
		// Codex caught the earlier version of this arm passing if the SVG survived at all — an arm that cannot fail is not a guard.
		// An <svg> under <math> sits in an ancestry this pass never approved, so it must be refused outright.
		const html = out('<math><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></math>');
		expect(html, "not carried into an unapproved ancestry").not.toContain("<svg");
		expect(html, "and no bare path left behind").not.toContain("<path");
		expect(html, "nor any unresolved slot text").not.toContain("EMDASHSVG");
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
