/**
 * The blog template's WpShell layout, drawn as a page is: the /wp-shell/
 * route, the layout, and the form the layout draws in the site's form
 * plugin's markup. EmDash's reads (the entry, the settings that carry the
 * record, the latest posts) are stood in for here; everything else is the
 * template's own code.
 *
 * - The front page's listing draws the site's latest posts: the layout asks
 *   EmDash for as many as WordPress listed, newest first, and maps each to
 *   what the listing draws (its title, path, excerpt, date and image).
 * - The document title is the entry's own SEO title, carried from WordPress,
 *   as written: the route passes it to the layout.
 * - A form imported from the site's form plugin is drawn in that plugin's
 *   markup, and submits what EmDash's own form submits, where it does.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WpShellForm from "../../../../templates/blog-cloudflare/src/components/WpShellForm.astro";
import WpShell from "../../../../templates/blog-cloudflare/src/layouts/WpShell.astro";
import WpShellRoute from "../../../../templates/blog-cloudflare/src/pages/wp-shell/[...path].astro";
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

describe("WpShell: the front page's listing draws the site's latest posts", () => {
	it("asks EmDash for as many posts as WordPress listed, newest first, and draws each in the theme's item", async () => {
		reads.getEmDashCollection.mockResolvedValue({
			entries: [
				{
					id: "first-post",
					data: {
						title: "First & best",
						excerpt: "",
						content: [
							{
								_type: "block",
								children: [{ _type: "span", text: "One two three four five six seven" }],
							},
						],
						publishedAt: new Date("2023-07-12T05:00:00Z"),
						featured_image: {
							provider: "local",
							id: "01ABC.png",
							src: "/_emdash/api/media/file/01ABC.png",
							width: 300,
							height: 200,
						},
					},
				},
				{
					id: "second",
					data: {
						title: "Second",
						excerpt: "Its own.",
						content: [],
						publishedAt: new Date("2022-12-18T20:00:00Z"),
					},
				},
			],
			cacheHint: {},
		});
		const c = await AstroContainer.create();
		const html = await c.renderToString(WpShell, {
			props: {
				shell: record(),
				kind: "home",
				path: "/",
				title: "Home",
				entry: { title: "Home", body: [], edit: { title: {}, content: {} } },
			},
		});
		expect(reads.getEmDashCollection).toHaveBeenCalledWith("posts", {
			orderBy: { published_at: "desc" },
			limit: 2,
		});
		expect(html).toContain(
			'<div class="items"><div class="item"><h3 class="item-title"><a href="/posts/first-post">First &amp; best</a></h3>' +
				'<p class="excerpt">One two three four five […]</p><span class="date">July 11, 2023</span>' +
				'<img class="wp-post-image" src="/_emdash/api/media/file/01ABC.png"></div>' +
				'<div class="item"><h3 class="item-title"><a href="/posts/second">Second</a></h3>' +
				'<p class="excerpt">Its own.</p><span class="date">December 18, 2022</span></div></div>',
		);
	});

	it("asks for no posts where the layout lists none", async () => {
		const c = await AstroContainer.create();
		await c.renderToString(WpShell, {
			props: {
				shell: record(),
				kind: "page",
				path: "/pages/about",
				title: "About",
				entry: { title: "About", body: [], edit: { title: {}, content: {} } },
			},
		});
		expect(reads.getEmDashCollection).not.toHaveBeenCalled();
	});
});

describe("the /wp-shell/ route: the document title", () => {
	async function page(seo: Record<string, unknown> | undefined) {
		reads.getEmDashEntry.mockResolvedValue({
			entry: {
				id: "contact",
				data: {
					id: "01PAGE",
					title: "Contact",
					content: [],
					translationGroup: "01PAGE",
					updatedAt: new Date("2026-09-01T00:00:00Z"),
					publishedAt: null,
					...(seo ? { seo } : {}),
				},
				edit: { title: {}, content: {} },
			},
			cacheHint: {},
		});
		const c = await AstroContainer.create();
		return c.renderToString(WpShellRoute, {
			params: { path: "pages/contact" },
			request: new Request("https://example.org/pages/contact"),
		});
	}
	const seo = (title: string | null) => ({
		title,
		description: null,
		image: null,
		canonical: null,
		noIndex: false,
	});

	it("is the entry's own SEO title, carried from WordPress, as written", async () => {
		const html = await page(seo("Write to us"));
		expect(reads.getEmDashEntry).toHaveBeenCalledWith("pages", "contact");
		expect(html).toContain("<title>Write to us</title>");
	});

	it("is EmDash's title and the site's name for an entry with none", async () => {
		expect(await page(seo(null))).toContain("<title>Contact | Example</title>");
		expect(await page(undefined)).toContain("<title>Contact | Example</title>");
	});
});

describe("WpShell: a single post in the record's post layout", () => {
	/** The record with a post layout: its meta, and the theme's comment element. */
	const withPost = () => ({
		...record(),
		post: {
			body: { class: "single single-post" },
			styles: ["/_emdash/api/media/file/wp-shell/post.css"],
			parts: [
				{ html: '<main id="site-content"><div class="post hentry">' },
				{ slot: "title", tag: "h1", class: "entry-title" },
				{ slot: "postMeta", meta: 0 },
				{ slot: "content", tag: "div", class: "entry-content" },
				{ slot: "comments", tag: "div", class: "comment-respond", id: "respond" },
				{ html: "</div></main>" },
			],
			date: "F j, Y",
			utcOffset: -480,
			meta: [
				[
					'<p class="entry-meta"><a href="',
					HOLE("href"),
					'">',
					HOLE("date"),
					"</a> by ",
					HOLE("author"),
					"</p>",
				],
			],
			share: ['<div class="sharedaddy"><a href="', HOLE("share-x"), '">X</a></div>'],
		},
	});
	async function draw(shell: unknown, post: unknown) {
		const c = await AstroContainer.create();
		return c.renderToString(WpShell, {
			props: {
				shell,
				kind: "post",
				path: "/posts/a-post",
				title: "A Post",
				entry: { title: "A Post", body: [], edit: { title: {}, content: {} } },
				post,
			},
			slots: { default: '<section class="ec-comments">EMDASH COMMENTS</section>' },
		});
	}
	const fill = {
		url: "/posts/a-post",
		absoluteUrl: "https://example.org/posts/a-post",
		title: "A Post",
		date: new Date("2014-05-01T05:57:19Z"),
		author: "Pat & Co",
	};

	it("draws EmDash's comments inside the theme's comment element, and the post's meta and share links", async () => {
		const html = await draw(withPost(), fill);
		expect(html).toContain(
			'<div class="comment-respond" id="respond"><section class="ec-comments">EMDASH COMMENTS</section></div>',
		);
		expect(html.match(/EMDASH COMMENTS/g)).toHaveLength(1);
		expect(html).toContain(
			'<p class="entry-meta"><a href="/posts/a-post">April 30, 2014</a> by Pat &amp; Co</p>',
		);
		expect(html).toMatch(
			/<div class="entry-content"[^>]*><div class="sharedaddy"><a href="https:\/\/x\.com\/intent\/tweet\?url=https%3A%2F%2Fexample\.org%2Fposts%2Fa-post&amp;text=A%20Post">X<\/a><\/div><\/div>/,
		);
		expect(html).toContain('<body class="single single-post">');
		expect(html).toContain('href="/_emdash/api/media/file/wp-shell/post.css"');
	});

	it("draws a post after its content, in the record's own layout, for a record with no post layout", async () => {
		const html = await draw(record(), fill);
		expect(html).toMatch(
			/<div class="entry-content"[^>]*><\/div><section class="ec-comments">EMDASH COMMENTS<\/section><\/main>/,
		);
		expect(html).not.toContain("entry-meta");
	});
});
