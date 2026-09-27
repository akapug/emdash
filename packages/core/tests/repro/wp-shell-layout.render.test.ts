/**
 * The blog template's WpShell layout draws a form imported from the site's
 * form plugin in that plugin's markup (WpShellForm), and it submits what
 * EmDash's own form submits, where it does. EmDash's reads (the settings that
 * carry the record) are stood in for here; everything else is the template's
 * own code.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WpShellForm from "../../../../templates/blog-cloudflare/src/components/WpShellForm.astro";
import FormEmbed from "../../../plugins/forms/src/astro/FormEmbed.astro";
import type { PublicFormDefinition } from "../../../plugins/forms/src/public-definition.js";

const reads = vi.hoisted(() => ({
	shell: null as unknown,
	getEmDashCollection: vi.fn(),
	getEmDashEntry: vi.fn(),
}));

/** EmDash's reads, as the template imports them from "emdash"; its SEO helpers are its own. */
async function emdashReads() {
	const seo = await import("../../src/seo/index.js");
	const slug = await import("../../src/utils/slugify.js");
	return {
		getSeoMeta: seo.getSeoMeta,
		getContentSeo: seo.getContentSeo,
		decodeSlug: slug.decodeSlug,
		getEmDashCollection: reads.getEmDashCollection,
		getEmDashEntry: reads.getEmDashEntry,
		getHomepage: async () => ({ entry: null, collection: "pages", cacheHint: {} }),
		getMenuWithCacheHint: async () => ({ data: null, cacheHint: {} }),
		getSiteSettings: async () => ({ title: "Example" }),
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Example", wpShell: reads.shell },
			cacheHint: {},
		}),
	};
}
// The template resolves "emdash" to the package's built entry.
vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);

const HOLE = (s: string) => ({ s });

/** A shell record as Embark's writer produces one: a page layout, a front page with a listing, a form. */
function record() {
	return {
		version: 1,
		id: "0123456789abcdef01234567",
		source: { url: "https://example.org/", capturedAt: "2026-09-26T00:00:00.000Z" },
		html: { lang: "en-US", class: "" },
		body: { class: "page page-template-default" },
		styles: ["/_emdash/api/media/file/wp-shell/abc.css"],
		parts: [
			{ html: '<header id="site-header"></header><main id="site-content">' },
			{ slot: "title", tag: "h1", class: "entry-title" },
			{ slot: "content", tag: "div", class: "entry-content" },
			{ html: "</main>" },
		],
		menus: [],
		listings: [
			{
				count: 2,
				item: [
					'<div class="',
					HOLE("cls"),
					'"><h3 class="item-title"><a href="',
					HOLE("href"),
					'">',
					HOLE("title"),
					'</a></h3><p class="excerpt">',
					HOLE("excerpt"),
					'</p><span class="date">',
					HOLE("date"),
					"</span>",
					HOLE("thumb"),
					"</div>",
				],
				thumb: ['<img class="wp-post-image" src="', HOLE("src"), '">'],
				classes: ["item"],
				date: "F j, Y",
				utcOffset: -480,
				excerpt: { words: 5, more: " […]" },
			},
		],
		home: {
			body: { class: "home" },
			styles: ["/_emdash/api/media/file/wp-shell/front.css"],
			parts: [
				{ html: '<div class="highlights">' },
				{ slot: "title", tag: "h2" },
				{ slot: "content", tag: "div" },
				{ html: '<div class="items">' },
				{ slot: "listing", listing: 0 },
				{ html: "</div></div>" },
			],
		},
		forms: [
			{
				plugin: "gravityforms",
				fields: [
					{ name: "input_2_3", label: "Your Name: First", type: "text", required: true },
					{
						name: "input_1",
						label: "Your Email",
						type: "email",
						required: true,
						help: "We write rarely.",
					},
					{ name: "input_6", label: "Keep me up to date", type: "checkbox", required: false },
					{ name: "input_3", label: "Comments?", type: "textarea", required: false },
				],
				parts: [
					'<div class="gform_wrapper">',
					{ s: "form" },
					'<ul class="gform_fields"><li class="gfield"><span class="name_first">',
					{ s: "control", field: 0 },
					{ s: "label", field: 0 },
					"First",
					{ s: "/label" },
					'</span></li><li class="gfield">',
					{ s: "label", field: 1, class: "gfield_label" },
					"Your Email",
					{ s: "/label" },
					{ s: "control", field: 1 },
					'<div class="gfield_description">We write rarely.</div></li><li class="gfield">',
					{ s: "control", field: 2 },
					{ s: "label", field: 2 },
					"Keep me up to date",
					{ s: "/label" },
					'</li><li class="gfield">',
					{ s: "control", field: 3, class: "textarea medium", rows: 10, cols: 50 },
					'</li></ul><div class="gform_footer">',
					{ s: "submit", tag: "input", class: "gform_button button" },
					"</div>",
					{ s: "/form" },
					"</div>",
				],
			},
		],
	};
}

/** The EmDash form the importer made of the Gravity Forms form. */
function definition(): PublicFormDefinition {
	return {
		name: "Get in touch",
		slug: "wp-gf-2",
		pages: [
			{
				fields: [
					{
						id: "a",
						type: "text",
						label: "Your Name: First",
						name: "input_2_3",
						required: true,
						width: "half",
					},
					{
						id: "b",
						type: "email",
						label: "Your Email",
						name: "input_1",
						required: true,
						width: "full",
						helpText: "We write rarely.",
					},
					{
						id: "c",
						type: "checkbox",
						label: "Keep me up to date",
						name: "input_6",
						required: false,
						width: "full",
					},
					{
						id: "d",
						type: "textarea",
						label: "Comments?",
						name: "input_3",
						required: false,
						width: "full",
						validation: { maxLength: 1000 },
					},
				],
			},
		],
		settings: { spamProtection: "honeypot", submitLabel: "Get in touch!" },
		status: "active",
		_turnstileSiteKey: null,
	};
}

const answering = (def: PublicFormDefinition) => ({
	emdash: { handlePublicPluginApiRoute: async () => ({ success: true, data: def }) },
});

/**
 * Each control a form submits: its name, type, value, and the checks a
 * browser makes before it sends. A control with no name submits nothing.
 */
function controls(html: string): string[] {
	const form = /<form\b[\s\S]*<\/form>/.exec(html)?.[0] ?? "";
	return [...form.matchAll(/<(input|select|textarea)\b([^>]*)>/g)]
		.flatMap(([, tag, attrs]) => {
			const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(attrs!)?.[1] ?? "";
			const flag = (n: string) => (new RegExp(`\\s${n}(?=[\\s>=]|$)`).test(attrs!) ? n : "");
			const name = attr("name");
			const type = tag === "input" ? attr("type") : tag;
			return name
				? [
						[name, type, flag("required"), attr("maxlength"), attr("value")]
							.filter(Boolean)
							.join(" "),
					]
				: [];
		})
		.toSorted();
}

/** The form element's own attributes: where and how it submits. */
const formTag = (html: string) => {
	const tag = /<form\b([^>]*)>/.exec(html)?.[1] ?? "";
	return ["method", "action", "data-form-id"].map(
		(n) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1],
	);
};

beforeEach(() => {
	reads.shell = record();
	reads.getEmDashCollection.mockReset();
	reads.getEmDashEntry.mockReset();
});

describe("WpShellForm: a form in its plugin's markup", () => {
	async function draw(component: typeof WpShellForm, def = definition()) {
		const c = await AstroContainer.create();
		return c.renderToString(component, {
			props: { node: { formId: "01FORM" } },
			locals: answering(def),
		});
	}

	it("draws the imported form in the plugin's markup, submitting what EmDash's own form submits, where it does", async () => {
		const skinned = await draw(WpShellForm);
		const own = await draw(FormEmbed);
		expect(skinned).toContain('<div class="gform_wrapper">');
		expect(skinned).toContain('data-ec-skin="gravityforms"');
		expect(skinned).not.toContain('class="ec-form"');
		expect(controls(skinned)).toEqual(controls(own));
		expect(controls(skinned)).toEqual([
			"_hp text",
			"formId hidden 01FORM",
			"input_1 email required",
			"input_2_3 text required",
			"input_3 textarea 1000",
			"input_6 checkbox 1",
		]);
		expect(formTag(skinned)).toEqual(formTag(own));
		expect(formTag(skinned)).toEqual([
			"POST",
			"/_emdash/api/plugins/emdash-forms/submit",
			"01FORM",
		]);
		// the forms plugin's own client runs it, as it runs EmDash's own form
		expect(skinned).toMatch(/<script\b/);
	});

	it("draws a form an admin has changed, or one of no skin, in EmDash's own markup", async () => {
		const changed = definition();
		changed.pages[0]!.fields[1]!.label = "Email address";
		for (const [what, html] of [
			["a changed label", await draw(WpShellForm, changed)],
			[
				"a record with no forms",
				await (async () => {
					reads.shell = { ...record(), forms: undefined };
					return draw(WpShellForm);
				})(),
			],
		] as const) {
			expect(html, what).toContain('class="ec-form"');
			expect(html, what).not.toContain("gform_wrapper");
		}
	});
});
