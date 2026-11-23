/**
 * Look-C Popup Maker dialogs (Item 105): WpShell.astro renders active popups
 * carried in `record.popups` as accessible `<dialog class="wp-shell-popup">`
 * elements with their trigger metadata (`auto_open`, `click_open`, `exit_intent`)
 * and respects `scope: "home"` so front-page popups do not reopen on inner pages.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import WpShell from "../../../../templates/blog-cloudflare/src/layouts/WpShell.astro";
import {
	popupsFor,
	wpShellProblem,
	type WpShell as WpShellRecord,
} from "../../../../templates/blog-cloudflare/src/utils/wp-shell.js";

async function emdashReads() {
	const seo = await import("../../src/seo/index.js");
	const sanitize = await import("../../src/utils/sanitize.js");
	const url = await import("../../src/utils/url.js");
	return {
		getSeoMeta: seo.getSeoMeta,
		getContentSeo: seo.getContentSeo,
		sanitizeContent: sanitize.sanitizeContent,
		sanitizeHref: url.sanitizeHref,
		getEditMeta: () => undefined,
		getEmDashCollection: async () => ({ entries: [], cacheHint: {} }),
		getPublishedDates: async () => ({ dates: [], cacheHint: {} }),
		getMenuWithCacheHint: async () => ({ data: null, cacheHint: {} }),
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Example" },
			cacheHint: {},
		}),
		getWidgetAreaWithCacheHint: async () => ({ data: null, cacheHint: {} }),
	};
}

vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);

function popupShell(popups: WpShellRecord["popups"]): WpShellRecord {
	return {
		version: 1,
		id: "deadbeef1234567890abcdef",
		source: { url: "https://example.org/", capturedAt: "2026-11-23T00:00:00.000Z" },
		html: { lang: "en", class: "" },
		body: { class: "home page" },
		styles: [],
		menus: [],
		parts: [
			{ html: '<header><a href="#popmake-900" class="popmake-900">Open</a></header><main>' },
			{ slot: "title", tag: "h1" },
			{ slot: "content", tag: "div" },
			{ html: "</main>" },
		],
		...(popups ? { popups } : {}),
	};
}

describe("Look-C Popup Maker dialogs (Item 105)", () => {
	it("validates record.popups and rejects executable markup or unsafe trigger selectors", () => {
		const good = popupShell([
			{
				id: "1456",
				slug: "eoy-26",
				html: '<p><a href="/join-in/donate/">Double the impact!</a></p>',
				closeLabel: "CLOSE",
				closeOnEsc: false,
				triggers: [{ type: "auto_open", delayMs: 500 }],
				scope: "home",
			},
		]);
		expect(wpShellProblem(good)).toBeNull();

		const badHtml = popupShell([
			{
				id: "1456",
				html: "<p>Hi</p><script>alert(1)</script>",
				triggers: [{ type: "auto_open", delayMs: 500 }],
			},
		]);
		expect(wpShellProblem(badHtml)).not.toBeNull();

		const badSel = popupShell([
			{
				id: "900",
				html: "<p>Hi</p>",
				triggers: [{ type: "click_open", selectors: ["a; alert(1)"] }],
			},
		]);
		expect(wpShellProblem(badSel)).toMatch(/selector is unsafe/);
	});

	it("renders a home-scoped auto_open popup on kind='home' and omits it on kind='page'", async () => {
		const shell = popupShell([
			{
				id: "1456",
				slug: "eoy-26",
				html: '<p><a href="/join-in/donate/">Double the impact!</a></p><span class="pum-close popmake-close">Continue to the homepage.</span>',
				closeLabel: "CLOSE",
				closeOnEsc: false,
				triggers: [{ type: "auto_open", delayMs: 500 }],
				scope: "home",
			},
		]);
		expect(popupsFor(shell, "home")).toHaveLength(1);
		expect(popupsFor(shell, "page")).toHaveLength(0);
		expect(popupsFor(shell, "post")).toHaveLength(0);

		const container = await AstroContainer.create();
		const homeHtml = await container.renderToString(WpShell, {
			props: {
				shell,
				kind: "home",
				path: "/",
				title: "Home",
				entry: { title: "Home", body: [] },
				comments: false,
			},
			request: new Request("https://example.org/"),
		});
		expect(homeHtml).toContain('id="wp-shell-popup-1456"');
		expect(homeHtml).toContain('class="wp-shell-popup"');
		expect(homeHtml).toContain('data-wp-shell-popup="1456"');
		expect(homeHtml).toContain("auto_open");
		expect(homeHtml).toContain("Double the impact!");
		expect(homeHtml).toContain("Continue to the homepage.");
		expect(homeHtml).toContain("CLOSE");
		expect(homeHtml).toContain("dialog.showModal()");

		const donateHtml = await container.renderToString(WpShell, {
			props: {
				shell,
				kind: "page",
				path: "/join-in/donate/",
				title: "Donate",
				entry: { title: "Donate", body: [] },
				comments: false,
			},
			request: new Request("https://example.org/join-in/donate/"),
		});
		expect(donateHtml).not.toContain("wp-shell-popup-1456");
		expect(donateHtml).not.toContain("dialog.showModal()");
	});
});
