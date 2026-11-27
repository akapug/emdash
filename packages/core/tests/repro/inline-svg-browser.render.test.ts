/**
 * Item 163g, codex's last requirement: the proof must be in a real browser, on BOTH production callers, with mixed media AND SVG, and the
 * network silence must cover same-origin as well as off-origin.
 *
 * The earlier caller arms asserted rendered strings from AstroContainer, which is server markup — codex rejected that, correctly: a string can
 * be right while the DOM a browser builds from it makes a request. The media arm also carried no SVG at all, so it proved nothing about icons.
 *
 * Chromium is launched directly (playwright-core). The job installs it; a browser that cannot start FAILS the run rather than skipping.
 */

import { expect, it } from "vitest";

import { sanitizeContent } from "../../src/utils/sanitize.js";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M224 256A128 128 0 1 0 224 0z"/></svg>';
/** Mixed content: an icon, a real image, a link and prose, as a page-builder block would carry. */
const MIXED = `<div class="uagb-info-box">${ICON}<img src="/media/photo.jpg" alt="A photo"><a href="https://example.org/x">link</a><p>Prose</p></div>`;
/** A lookalike that tries to buy admission with the old attribute, and one with an unapproved ancestor. */
const ATTACKS =
	'<svg data-embark-svg="1" viewBox="0 0 10 10"><script>alert(1)</script></svg>' +
	'<math><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></math>';

const host = (body: string): string => `<!doctype html><html><body><div class="emdash-html-block">${body}</div></body></html>`;

const browserP = (async () => {
	const { chromium } = await import(process.env.EMBARK_PLAYWRIGHT_CORE ?? "playwright-core");
	return chromium.launch(process.env.EMBARK_CHROMIUM_PATH ? { executablePath: process.env.EMBARK_CHROMIUM_PATH } : {});
})();

it("with mixed media and an icon: the icon is real DOM, the media survives, and NOTHING is fetched", async () => {
	const browser = await browserP;
	const page = await browser.newPage();
	try {
		// Fulfil the document; refuse everything else and record it — same-origin included, which the earlier arms never covered.
		const attempted: string[] = [];
		await page.route("**/*", (route) => {
			const url = route.request().url();
			if (url.startsWith("https://example.test/")) return route.fulfill({ contentType: "text/html", body: host(sanitizeContent(MIXED)) });
			attempted.push(url);
			return route.abort();
		});
		await page.goto("https://example.test/", { waitUntil: "networkidle" });

		const facts = await page.evaluate(() => ({
			svgs: document.querySelectorAll("svg").length,
			paths: document.querySelectorAll("svg path").length,
			viewBox: document.querySelector("svg")?.getAttribute("viewBox") ?? null,
			imgs: document.querySelectorAll("img").length,
			// The browser's own parsed href, so a javascript:/data: URL would show here.
			links: Array.from(document.querySelectorAll("a")).map((a) => a.href),
			descendants: Array.from(document.querySelectorAll("svg *")).map((e) => e.tagName.toLowerCase()),
		}));

		expect(facts.svgs, "the icon is real DOM an operator could see").toBe(1);
		expect(facts.paths, "with its geometry").toBe(1);
		expect(facts.viewBox, "viewBox survives as an attribute, cased correctly").toBe("0 0 448 512");
		expect(facts.imgs, "the mixed media image survived beside the icon").toBe(1);
		expect(facts.descendants.every((t) => ["path", "g"].includes(t)), "only approved SVG descendants").toBe(true);
		expect(facts.links.some((h) => h.startsWith("https://example.org/x")), "the ordinary link is untouched").toBe(true);
		expect(attempted, "no request at all — same-origin or off-origin — for anything the icon drew").toEqual([]);
	} finally {
		await page.close();
	}
});

it("both lookalikes are refused in the browser, and neither draws nor fetches", async () => {
	const browser = await browserP;
	const page = await browser.newPage();
	try {
		const attempted: string[] = [];
		await page.route("**/*", (route) => {
			const url = route.request().url();
			if (url.startsWith("https://example.test/")) return route.fulfill({ contentType: "text/html", body: host(sanitizeContent(`${ATTACKS}${MIXED}`)) });
			attempted.push(url);
			return route.abort();
		});
		await page.goto("https://example.test/", { waitUntil: "networkidle" });

		const facts = await page.evaluate(() => ({
			svgs: document.querySelectorAll("svg").length,
			scripts: document.querySelectorAll("script").length,
			hasAlertText: (document.body.textContent ?? "").includes("alert"),
			markerText: /EMDASHSVG|ENDSLOT/.test(document.body.innerHTML),
		}));

		// Exactly ONE svg: the legitimate one from MIXED. The forged-attribute icon and the MathML one are both absent.
		expect(facts.svgs, "only the legitimate icon").toBe(1);
		expect(facts.scripts, "no script element anywhere").toBe(0);
		expect(facts.hasAlertText, "no script body").toBe(false);
		expect(facts.markerText, "no unresolved slot text in the rendered page").toBe(false);
		expect(attempted, "the refused lookalikes fetched nothing").toEqual([]);
	} finally {
		await page.close();
	}
});
