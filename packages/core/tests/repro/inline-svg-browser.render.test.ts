/**
 * Item 163g, codex's third requirement: the browser proof must run the REAL COMPONENTS' output, and request accounting must be EXACT.
 *
 * Two earlier versions of this file were rejected, both fairly: the first used a synthetic wrapper, and the second called `sanitizeContent`
 * directly while its route handler fulfilled same-origin requests WITHOUT recording them — so "nothing was fetched" was only ever true of
 * what the handler chose to count. This version renders `HtmlBlock.astro` and `Embed.astro` through AstroContainer (the same path a
 * customer's page takes), puts that exact markup in Chromium, and counts EVERY request by name: the navigation, the one ordinary media
 * request the mixed content legitimately makes, and anything else. Any third request fails the arm by URL.
 */

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it, vi } from "vitest";

import Embed from "../../src/components/Embed.astro";
import HtmlBlock from "../../src/components/HtmlBlock.astro";

const settings = vi.hoisted(() => ({ iframeHosts: [] as unknown }));
vi.mock("../../src/settings/index.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getSiteSettings: async () => ({ iframeHosts: settings.iframeHosts }),
}));

const pageLocals = { emdash: { collectPageMetadata: () => [], collectPageFragments: () => [] } };

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M224 256A128 128 0 1 0 224 0z"/></svg>';
/** Mixed content as a page-builder block carries it: an icon, prose on both sides, and one ordinary image. */
const MIXED = `<div class="uagb-info-box">before ${ICON} after <img src="/media/photo.jpg" alt="A photo"></div>`;
const ATTACKS =
	'<svg data-embark-svg="1" viewBox="0 0 10 10"><script>alert(1)</script></svg>' +
	'<math><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></math>';

/** Render a real component to the markup the page would actually carry. */
async function renderComponent(component: typeof HtmlBlock, node: object): Promise<string> {
	const c = await AstroContainer.create();
	return c.renderToString(component, { props: { node }, locals: pageLocals });
}

const browserP = (async () => {
	const { chromium } = await import(process.env.EMBARK_PLAYWRIGHT_CORE ?? "playwright-core");
	return chromium.launch(process.env.EMBARK_CHROMIUM_PATH ? { executablePath: process.env.EMBARK_CHROMIUM_PATH } : {});
})();

const ORIGIN = "https://example.test";
/** The one ordinary request the fixture's `<img>` legitimately makes. Anything else is a finding. */
const EXPECTED_MEDIA = `${ORIGIN}/media/photo.jpg`;

/**
 * Serve a component's rendered body and record EVERY request, same-origin included. Returns the requests in order so a caller can assert
 * exact accounting rather than "nothing off-origin".
 */
async function serveAndRecord(page: import("playwright-core").Page, body: string): Promise<string[]> {
	const seen: string[] = [];
	await page.route("**/*", (route) => {
		const url = route.request().url();
		seen.push(url);
		if (url === `${ORIGIN}/` || url === ORIGIN) return route.fulfill({ contentType: "text/html", body: `<div class="emdash-html-block">${body}</div>` });
		if (url === EXPECTED_MEDIA) return route.fulfill({ contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
		return route.abort();
	});
	await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
	return seen;
}

it("HtmlBlock's own output: the icon is real DOM, media survives, and the request list is EXACTLY navigation + media", async () => {
	const body = await renderComponent(HtmlBlock, { _type: "htmlBlock", _key: "g", html: MIXED });
	expect(body, "the component itself drew the icon").toContain("<svg");

	const browser = await browserP;
	const page = await browser.newPage();
	try {
		const seen = await serveAndRecord(page, body);
		const facts = await page.evaluate(() => ({
			svgs: document.querySelectorAll("svg").length,
			paths: document.querySelectorAll("svg path").length,
			viewBox: document.querySelector("svg")?.getAttribute("viewBox") ?? null,
			imgs: document.querySelectorAll("img").length,
			text: document.body.textContent ?? "",
			leaksMarker: /EMDASHSVG|ENDSLOT/.test(document.documentElement.outerHTML),
			descendants: [...new Set(Array.from(document.querySelectorAll("svg *")).map((e) => e.tagName.toLowerCase()))],
		}));

		expect(facts.svgs, "exactly one icon in the browser").toBe(1);
		expect(facts.paths, "with its geometry").toBe(1);
		expect(facts.viewBox, "viewBox survives, cased correctly").toBe("0 0 448 512");
		expect(facts.imgs, "the mixed-media image beside it survived").toBe(1);
		expect(facts.text, "the prose on both sides survived").toContain("before");
		expect(facts.text).toContain("after");
		expect(facts.leaksMarker, "no slot marker becomes visible text").toBe(false);
		expect(facts.descendants.every((t) => t === "path" || t === "g"), "only approved SVG descendants").toBe(true);

		// EXACT ACCOUNTING: the navigation and the one expected media request, nothing else.
		expect(seen.sort(), "the navigation and the fixture's own image, and nothing else").toEqual([`${ORIGIN}/`, EXPECTED_MEDIA].sort());
	} finally {
		await page.close();
	}
});

it("Embed's own output: same guarantees through the second real caller", async () => {
	const body = await renderComponent(Embed, { _type: "embed", _key: "e", url: "https://example.org/x", html: MIXED });
	expect(body, "Embed drew the icon too").toContain("<svg");

	const browser = await browserP;
	const page = await browser.newPage();
	try {
		const seen = await serveAndRecord(page, body);
		const facts = await page.evaluate(() => ({
			svgs: document.querySelectorAll("svg").length,
			viewBox: document.querySelector("svg")?.getAttribute("viewBox") ?? null,
			imgs: document.querySelectorAll("img").length,
		}));
		expect(facts.svgs, "one icon").toBe(1);
		expect(facts.viewBox, "viewBox survives").toBe("0 0 448 512");
		expect(facts.imgs, "the image survived here too").toBe(1);
		expect(seen.sort(), "no request beyond navigation and the fixture's image").toEqual([`${ORIGIN}/`, EXPECTED_MEDIA].sort());
	} finally {
		await page.close();
	}
});

it("both lookalikes are refused through the real component, and the request list is unchanged", async () => {
	const body = await renderComponent(HtmlBlock, { _type: "htmlBlock", _key: "a", html: `${ATTACKS}${MIXED}` });
	const browser = await browserP;
	const page = await browser.newPage();
	try {
		const seen = await serveAndRecord(page, body);
		const facts = await page.evaluate(() => ({
			svgs: document.querySelectorAll("svg").length,
			scripts: document.querySelectorAll("script").length,
			alertText: (document.body.textContent ?? "").includes("alert"),
			leaksMarker: /EMDASHSVG|ENDSLOT/.test(document.documentElement.outerHTML),
		}));
		// Exactly ONE: the legitimate icon inside MIXED. The forged-attribute one and the MathML one are both refused.
		expect(facts.svgs, "only the legitimate icon").toBe(1);
		expect(facts.scripts, "no script element").toBe(0);
		expect(facts.alertText, "no script body").toBe(false);
		expect(facts.leaksMarker, "no marker text").toBe(false);
		// The refused lookalikes add no request of their own.
		expect(seen.sort(), "the refusals fetched nothing extra").toEqual([`${ORIGIN}/`, EXPECTED_MEDIA].sort());
	} finally {
		await page.close();
	}
});
