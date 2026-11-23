/**
 * Look-C footer widget areas (emb/143): WpShell.astro renders captured footer
 * widget areas (`footer-1..N`) and the copyright socket (`footer-bottom`) via
 * EmDash Widgets.
 *
 * - Before any seed (`getWidgetAreaWithCacheHint` returns `null`): the captured
 *   fallback markup renders verbatim inside the captured outer wrapper.
 * - Once seeded (`area !== null`): the EmDash widget area is the source of truth;
 *   admin edits redraw immediately, `htmlBlock` renders inline without extra
 *   `.emdash-html-block` wrappers, and an emptied area draws nothing (never falls
 *   back to captured HTML).
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import WpShell from "../../../../templates/blog-cloudflare/src/layouts/WpShell.astro";
import { wpShellProblem } from "../../../../templates/blog-cloudflare/src/utils/wp-shell.js";

const reads = vi.hoisted(() => ({
	getWidgetAreaWithCacheHint: vi.fn(
		async (_name: string): Promise<unknown> => ({ data: null, cacheHint: {} }),
	),
}));

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
		getWidgetAreaWithCacheHint: reads.getWidgetAreaWithCacheHint,
	};
}

vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);

const FOOTER_4_FALLBACK =
	'<div id="block-29" class="widget widget_block"><h4 class="has-text-align-center wp-block-heading">Contact Us!</h4></div>' +
	'<div id="block-23" class="widget widget_block widget_text"><p class="has-text-align-center wp-block-paragraph">hello@example.org</p></div>' +
	'<div id="block-24" class="widget widget_block widget_text"><p class="has-text-align-center wp-block-paragraph">555-0100</p></div>' +
	'<div id="block-37" class="widget widget_block widget_text"><p class="has-text-align-center wp-block-paragraph">123 Main St.</p></div>' +
	'<div id="block-38" class="widget widget_block widget_text"><p class="has-text-align-center wp-block-paragraph">Anytown, NC 28000</p></div>';
const SOCKET_FALLBACK =
	'<p style="text-align:center;"><strong>©2026 Example Arts</strong> Hand-crafted <a href="https://example.org">with ♥ by friends</a></p>';

function footerShell() {
	return {
		version: 1 as const,
		id: "0123456789abcdef01234567",
		source: { url: "https://example.org/", capturedAt: "2026-11-23T00:00:00.000Z" },
		html: { lang: "en-US", class: "" },
		body: { class: "page page-template-default" },
		styles: ["/_emdash/api/media/file/wp-shell/abc.css"],
		menus: [],
		parts: [
			{ html: '<header id="site-header"></header><main id="site-content">' },
			{ slot: "title" as const, tag: "h1" as const, class: "entry-title" },
			{ slot: "content" as const, tag: "div" as const, class: "entry-content" },
			{
				html: '</main><div id="footer" class="footer-color border-top"><div id="footer-sidebar-4" class="footer-sidebar widget-area" role="complementary">',
			},
			{
				slot: "widgetArea" as const,
				area: "footer-4",
				label: "Contact Us!",
				fallback: FOOTER_4_FALLBACK,
			},
			{ html: '</div></div><div id="socket" class="socket-color"><div class="col-sm-12">' },
			{
				slot: "widgetArea" as const,
				area: "footer-bottom",
				label: "Footer bottom",
				fallback: SOCKET_FALLBACK,
			},
			{ html: "</div></div>" },
		],
	};
}

async function renderFooterShell() {
	const container = await AstroContainer.create();
	return container.renderToString(WpShell, {
		props: {
			shell: footerShell(),
			kind: "page",
			path: "/about",
			title: "About",
			entry: { title: "About", body: [] },
		},
	});
}

describe("WpShell widgetArea slots (emb/143)", () => {
	it("accepts valid widgetArea slots and rejects invalid area names or missing fallbacks", () => {
		expect(wpShellProblem(footerShell())).toBeNull();
		expect(
			wpShellProblem({
				...footerShell(),
				parts: [
					...footerShell().parts,
					{ slot: "widgetArea", area: "BAD AREA!", fallback: "<p>x</p>" },
				],
			}),
		).toMatch(/widgetArea/);
		expect(
			wpShellProblem({
				...footerShell(),
				parts: [...footerShell().parts, { slot: "widgetArea", area: "footer-1" }],
			}),
		).toMatch(/widgetArea/);
	});

	it("draws the captured fallback verbatim before any seed (area === null)", async () => {
		reads.getWidgetAreaWithCacheHint.mockResolvedValue({ data: null, cacheHint: {} });
		const html = await renderFooterShell();
		expect(html).toContain(
			'<div id="footer-sidebar-4" class="footer-sidebar widget-area" role="complementary">',
		);
		expect(html).toContain("555-0100");
		expect(html).toContain("123 Main St.");
		expect(html).toContain("©2026 Example Arts");
	});

	it("redraws from EmDash widgets once seeded, preserves wrapper classes, and draws htmlBlock without extra wrapper", async () => {
		reads.getWidgetAreaWithCacheHint.mockImplementation(async (name: string) => {
			if (name === "footer-4") {
				return {
					data: {
						id: "area-4",
						name: "footer-4",
						label: "Contact Us!",
						widgets: [
							{
								id: "w-4",
								type: "content",
								content: [
									{
										_type: "block",
										_key: "b1",
										style: "h4",
										textAlign: "center",
										children: [{ _type: "span", _key: "s1", text: "Contact Us!", marks: [] }],
										markDefs: [],
									},
									{
										_type: "block",
										_key: "b2",
										style: "normal",
										textAlign: "center",
										children: [{ _type: "span", _key: "s2", text: "555-0199", marks: [] }],
										markDefs: [],
									},
									{
										_type: "block",
										_key: "b3",
										style: "normal",
										textAlign: "center",
										children: [
											{ _type: "span", _key: "s3", text: "456 Oak Ave, Othertown, NC 28001", marks: [] },
										],
										markDefs: [],
									},
								],
							},
						],
					},
					cacheHint: { tags: ["widget-area:footer-4"] },
				};
			}
			if (name === "footer-bottom") {
				return {
					data: {
						id: "area-bottom",
						name: "footer-bottom",
						label: "Footer bottom",
						widgets: [
							{
								id: "w-bottom",
								type: "content",
								content: [
									{
										_type: "htmlBlock",
										_key: "h1",
										html: '<p style="text-align:center;"><strong>©2027 Example Arts</strong></p>',
									},
								],
							},
						],
					},
					cacheHint: { tags: ["widget-area:footer-bottom"] },
				};
			}
			return { data: null, cacheHint: {} };
		});

		const html = await renderFooterShell();
		expect(html).toContain(
			'<div id="footer-sidebar-4" class="footer-sidebar widget-area" role="complementary">',
		);
		expect(html).toContain("555-0199");
		expect(html).toContain("456 Oak Ave, Othertown, NC 28001");
		expect(html).not.toContain("555-0100");
		expect(html).not.toContain("123 Main St.");
		expect(html).toContain("©2027 Example Arts");
		expect(html).not.toContain("emdash-html-block");
	});

	it("draws nothing when a seeded widget area is emptied (does not fall back)", async () => {
		reads.getWidgetAreaWithCacheHint.mockImplementation(async (name: string) => ({
			data: { id: `area-${name}`, name, label: name, widgets: [] },
			cacheHint: { tags: [`widget-area:${name}`] },
		}));
		const html = await renderFooterShell();
		expect(html).toContain(
			'<div id="footer-sidebar-4" class="footer-sidebar widget-area" role="complementary"></div>',
		);
		expect(html).not.toContain("555-0100");
		expect(html).not.toContain("©2026 Example Arts");
	});
});
