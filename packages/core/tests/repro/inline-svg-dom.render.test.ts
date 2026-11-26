/**
 * Item 163g: the BROWSER-DOM proof codex requires before approval.
 *
 * The unit arms assert strings. This asserts the DOM a browser actually builds from sanitizeContent's output, because an SVG string can
 * be well-formed and still produce nodes, attributes or requests the allowlist never intended:
 *
 *   1. the 11 real icons are retained (both shapes measured from the exports);
 *   2. the final DOM holds only approved SVG descendants;
 *   3. no event or URL attribute survives on any of them;
 *   4. nothing is reparented out of the SVG, and the SVG triggers no network request.
 *
 * Runs in Chromium via Playwright's `chromium.launch()`, installed in the same job (a fab sandbox does not keep it between jobs).
 */

import { expect, test } from "vitest";

import { sanitizeContent } from "../../src/utils/sanitize.js";

const TWPE_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M224 256A128 128 0 1 0 224 0a128 128 0 1 0 0 256zm-45.7 48C79.8 304 0 383.8 0 482.3 0 498.7 13.3 512 29.7 512H418.3c16.4 0 29.7-13.3 29.7-29.7C448 383.8 368.2 304 269.7 304H178.3z"/></svg>';

const CALULTI_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32"><g transform="translate(-511, -20)"><path d="M0 0h32v32H0z" fill="#333" fill-rule="evenodd"/></g></svg>';

const elevenIcons = (): string =>
	`<div class="uagb-info-box">${TWPE_ICON.repeat(5)}</div><ul class="uagb-icon-list">${(`<li>${TWPE_ICON}</li>`).repeat(5)}</ul>${CALULTI_ICON}`;

const APPROVED_TAGS = ["svg", "g", "path"];
const APPROVED_ATTRS = [
	"viewBox", "preserveAspectRatio", "width", "height", "fill", "stroke", "stroke-width",
	"stroke-linecap", "stroke-linejoin", "fill-rule", "opacity", "fill-opacity", "stroke-opacity",
	"transform", "d", "role", "aria-hidden", "aria-label", "focusable",
];

const host = (body: string): string =>
	`<!doctype html><html><body><div class="emdash-html-block">${body}</div></body></html>`;

/** Launch Chromium once for this file. A browser that cannot start fails the run rather than skipping it. */
const browserP = (async () => {
	// The repo's own Playwright, reached by its real path: `playwright-core` is not a dependency of `packages/core`, and a bare
	// specifier fails there. The caller passes the resolved directory in, so this never guesses at node_modules layout.
	const mod = await import(process.env.EMBARK_PLAYWRIGHT_CORE ?? "playwright-core");
	const { chromium } = mod as typeof import("playwright-core");
	const exe = process.env.EMBARK_CHROMIUM_PATH;
	return chromium.launch(exe ? { executablePath: exe } : {});
})();

test("the 11 real icons survive as SVG in a real DOM, with approved descendants only", async () => {
	const browser = await browserP;
	const page = await browser.newPage();
	try {
		await page.setContent(host(sanitizeContent(elevenIcons())), { waitUntil: "load" });
		const facts = await page.evaluate(
			([tags, attrs]) => {
				const okT = new Set(tags as string[]);
				const okA = new Set(attrs as string[]);
				const svgs = Array.from(document.querySelectorAll("svg"));
				const badTags = new Set<string>();
				const badAttrs = new Set<string>();
				let viewBoxIntact = 0;
				let geometries = 0;
				let reparented = 0;
				for (const svg of svgs) {
					if (svg.getAttribute("viewBox")) viewBoxIntact++;
					for (const el of Array.from(svg.querySelectorAll("*"))) {
						const t = el.tagName.toLowerCase();
						if (!okT.has(t)) badTags.add(t);
						if (t === "path" && el.getAttribute("d")) geometries++;
						if (el.closest("svg") !== svg) reparented++;
					}
					for (const el of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
						for (const a of Array.from(el.attributes)) if (!okA.has(a.name)) badAttrs.add(a.name);
					}
				}
				return { svgCount: svgs.length, badTags: [...badTags], badAttrs: [...badAttrs], viewBoxIntact, geometries, reparented };
			},
			[APPROVED_TAGS, APPROVED_ATTRS] as [string[], string[]],
		);

		expect(facts.svgCount, "10 twpe + 1 calulti, the measured population").toBe(11);
		expect(facts.viewBoxIntact, "every icon keeps its viewBox, cased as SVG requires").toBe(11);
		expect(facts.geometries, "every icon keeps its drawn path").toBe(11);
		expect(facts.badTags, "no element outside svg/g/path").toEqual([]);
		expect(facts.badAttrs, "no attribute outside the approved list").toEqual([]);
		expect(facts.reparented, "nothing reparented out of the SVG").toBe(0);
	} finally {
		await page.close();
	}
});

test("no event or URL attribute reaches the DOM on any SVG node", async () => {
	const browser = await browserP;
	const page = await browser.newPage();
	try {
		const html = sanitizeContent(
			`${elevenIcons()}<svg viewBox="0 0 10 10" ONLOAD="alert(1)"><path onClick="alert(2)" d="M0 0"/></svg>` +
				'<svg viewBox="0 0 10 10"><use href="https://evil.test/x.svg#a"/><image href="https://evil.test/p.png"/></svg>',
		);
		await page.setContent(host(html), { waitUntil: "load" });
		const dangerous = await page.evaluate(() =>
			Array.from(document.querySelectorAll("svg, svg *")).flatMap((el) =>
				Array.from(el.attributes)
					.filter((a) => /^on/i.test(a.name) || /^(href|xlink:href)$/i.test(a.name) || /^\s*(javascript|data|https?):/i.test(a.value))
					.map((a) => `${el.tagName.toLowerCase()}[${a.name}=${a.value}]`),
			),
		);
		// PRESENCE GUARD. Without it this arm passes on a page with no SVG at all, which is exactly what the pre-pass being
		// disabled produces: "no dangerous attribute survived" is trivially true of nothing. Measured by the tooth — this arm went
		// green with the pre-pass off until the guard was added.
		const svgPresent = await page.evaluate(() => document.querySelectorAll("svg").length);
		expect(svgPresent, "the icons must be there for this to be a claim about them").toBeGreaterThanOrEqual(11);
		expect(dangerous, "not one event handler or URL-bearing attribute").toEqual([]);
	} finally {
		await page.close();
	}
});

test("the SVG triggers no network request: an icon that fetches is not an icon", async () => {
	const browser = await browserP;
	const page = await browser.newPage();
	try {
		const offOrigin: string[] = [];
		await page.route("**/*", (route) => {
			const url = route.request().url();
			if (!url.startsWith("https://example.test/")) {
				offOrigin.push(url);
				return route.abort();
			}
			return route.fulfill({ contentType: "text/html", body: host(sanitizeContent(elevenIcons())) });
		});
		await page.goto("https://example.test/", { waitUntil: "networkidle" });
		// PRESENCE GUARD, for the same reason as the arm above: an empty page makes no requests, so this must first prove there
		// are icons whose geometry a browser could try to resolve.
		const svgPresent = await page.evaluate(() => document.querySelectorAll("svg").length);
		expect(svgPresent, "eleven icons drawn, so a fetch would have something to fetch for").toBe(11);
		expect(offOrigin, "no request left the page for anything the SVG drew").toEqual([]);
	} finally {
		await page.close();
	}
});

test("the other four sites, which carry no SVG, are unchanged by this pass", async () => {
	const before = '<p>Prose with an ampersand &amp; a <a href="https://example.org/x">link</a>.</p>';
	expect(sanitizeContent(before), "a page with no SVG passes through as it did").toContain("example.org/x");
	expect(sanitizeContent(before)).not.toContain("<svg");
});
