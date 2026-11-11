/**
 * The blog template's WpShell layout draws a page a builder made on
 * WordPress (Elementor) inside the builder's own elements, which Embark's
 * import stores on the blocks that carry the layout as `skeleton`
 * (templates/blog-cloudflare/src/utils/wp-skeleton.ts). The words, images and
 * links stay EmDash's own blocks, drawn by its PortableText. All data is
 * synthetic, in the shape the import stores (example.org, invented ids).
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import WpShellBlock from "../../../../templates/blog-cloudflare/src/components/WpShellBlock.astro";
import WpShellImage from "../../../../templates/blog-cloudflare/src/components/WpShellImage.astro";
import WpShellSkeleton from "../../../../templates/blog-cloudflare/src/components/WpShellSkeleton.astro";
import {
	hasSkeleton,
	skeletonTree,
} from "../../../../templates/blog-cloudflare/src/utils/wp-skeleton";

const components = { block: WpShellBlock, type: { image: WpShellImage } };
const locals = { emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` } };

const text = (key: string, t: string, style = "normal") => ({
	_type: "block",
	_key: key,
	style,
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-s`, text: t, marks: [] }],
});
const wrap = (tag: string, cls: string, attrs?: Record<string, string>, lead?: unknown[]) => ({
	tag,
	class: cls,
	...(attrs ? { attrs } : {}),
	...(lead ? { lead } : {}),
});
const widget = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
	wraps: [
		wrap(
			"div",
			`elementor-element elementor-element-${id} elementor-widget elementor-widget-${type}`,
			{ "data-id": id, "data-element_type": "widget", "data-widget_type": `${type}.default` },
		),
		wrap("div", "elementor-widget-container"),
	],
	...extra,
});
const added = {
	wraps: [
		wrap("div", "elementor-element elementor-widget elementor-widget-text-editor"),
		wrap("div", "elementor-widget-container"),
	],
};
const DOC = wrap("div", "elementor elementor-924", {
	"data-elementor-type": "wp-page",
	"data-elementor-id": "924",
});
const sectionWraps = (id: string, inner = false) => [
	wrap(
		"section",
		`elementor-section ${inner ? "elementor-inner-section" : "elementor-top-section"} elementor-element elementor-element-${id}`,
		{ "data-id": id, "data-element_type": "section" },
		[wrap("div", "elementor-background-overlay")],
	),
	wrap("div", "elementor-container elementor-column-gap-default"),
];
const columnWraps = (id: string, size: number) => [
	wrap("div", `elementor-column elementor-col-${size} elementor-element elementor-element-${id}`, {
		"data-id": id,
		"data-element_type": "column",
	}),
	wrap("div", "elementor-widget-wrap elementor-element-populated"),
];

const BODY = [
	{
		_type: "elementor-section",
		_key: "el-1000001",
		skeleton: {
			document: DOC,
			wraps: [...sectionWraps("1000001"), ...columnWraps("1000002", 100)],
			widgets: {
				"1000003": widget("1000003", "heading", {
					blockClass: "elementor-heading-title elementor-size-default",
				}),
				"1000004": widget("1000004", "text-editor"),
				"1000005": widget("1000005", "spacer", {
					body: [wrap("div", "elementor-spacer"), wrap("div", "elementor-spacer-inner")],
				}),
			},
			added,
		},
	},
	text("el-1000003", "Top Articles", "h2"),
	text("el-1000004", "First paragraph."),
	text("el-1000004-1", "Second paragraph."),
	{ _type: "elementor-widget", _key: "el-1000005" },
	text("owner-added", "A paragraph the owner added."),
	{
		_type: "columns",
		_key: "el-1000006",
		skeleton: { inner: true, wraps: sectionWraps("1000006", true) },
		columns: [
			{
				_type: "column",
				_key: "el-1000007",
				content: [text("el-1000008", "Left")],
				skeleton: {
					wraps: columnWraps("1000007", 50),
					widgets: { "1000008": widget("1000008", "text-editor") },
					added,
				},
			},
			{
				_type: "column",
				_key: "el-1000009",
				content: [
					{
						_type: "htmlBlock",
						_key: "el-100000a",
						html: '<p class="x">Right</p><script>alert(1)</script><img src=x onerror="alert(2)">',
					},
				],
				skeleton: {
					wraps: columnWraps("1000009", 50),
					widgets: { "100000a": widget("100000a", "toggle") },
					added,
				},
			},
		],
	},
	{
		_type: "columns",
		_key: "el-200000b",
		skeleton: { document: DOC, wraps: sectionWraps("200000b") },
		columns: [
			{
				_type: "column",
				_key: "el-200000c",
				content: [text("el-200000d", "Second section")],
				skeleton: {
					wraps: columnWraps("200000c", 100),
					widgets: { "200000d": widget("200000d", "text-editor") },
					added,
				},
			},
		],
	},
];

async function render(body: unknown[]) {
	const c = await AstroContainer.create();
	return c.renderToString(WpShellSkeleton, {
		props: { nodes: skeletonTree(body as never), components },
		locals,
	});
}
const squash = (html: string) =>
	html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+data-astro-[a-z-]+(="[^"]*")?/g, "");

describe("the WpShell layout's page-builder skeleton", () => {
	it("is drawn only for a body that carries one", () => {
		expect(hasSkeleton(BODY)).toBe(true);
		expect(hasSkeleton([text("a", "Plain")])).toBe(false);
		expect(hasSkeleton(undefined)).toBe(false);
	});

	it("draws each section, column and widget around its own blocks, in the page's wrapper, once", async () => {
		const html = squash(await render(BODY));
		expect(html.match(/class="elementor elementor-924"/g)).toHaveLength(1);
		expect(html).toMatch(
			/^<div class="elementor elementor-924" data-elementor-type="wp-page" data-elementor-id="924"><section class="elementor-section elementor-top-section elementor-element elementor-element-1000001" data-id="1000001" data-element_type="section"><div class="elementor-background-overlay"><\/div><div class="elementor-container elementor-column-gap-default"><div class="elementor-column elementor-col-100 elementor-element elementor-element-1000002" data-id="1000002" data-element_type="column"><div class="elementor-widget-wrap elementor-element-populated">/,
		);
		// a heading carries the builder's title class; a widget's two paragraphs share one wrapper
		expect(html).toContain(
			'data-widget_type="heading.default"><div class="elementor-widget-container"><h2 class="elementor-heading-title elementor-size-default">Top Articles</h2></div></div>',
		);
		expect(html).toContain(
			'data-widget_type="text-editor.default"><div class="elementor-widget-container"><p>First paragraph.</p><p>Second paragraph.</p></div></div>',
		);
		// a spacer draws its own elements in its placeholder's place
		expect(html).toContain(
			'data-widget_type="spacer.default"><div class="elementor-widget-container"><div class="elementor-spacer"><div class="elementor-spacer-inner"></div></div></div></div>',
		);
		// a block the owner added is a text editor with no id
		expect(html).toContain(
			'<div class="elementor-element elementor-widget elementor-widget-text-editor"><div class="elementor-widget-container"><p>A paragraph the owner added.</p></div></div>',
		);
		// an inner section sits in the first section's column, before it closes; the next section is the page's own
		const inner = html.indexOf('data-id="1000006"');
		const second = html.indexOf('data-id="200000b"');
		expect(inner).toBeGreaterThan(html.indexOf("A paragraph the owner added."));
		expect(html.slice(inner, second)).toContain("</section></div></div></div></section>");
		expect(html).toContain(
			'data-id="1000007" data-element_type="column"><div class="elementor-widget-wrap elementor-element-populated"><div class="elementor-element elementor-element-1000008',
		);
		expect(html).toMatch(/<\/section><\/div>$/);
	});

	it("draws captured markup through EmDash's sanitizer, and no element, class or attribute the check does not allow", async () => {
		const html = squash(await render(BODY));
		expect(html).toContain("Right");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onerror");
		const hostile = squash(
			await render([
				{
					_type: "elementor-section",
					_key: "el-3000001",
					skeleton: {
						wraps: [
							{ tag: "script", class: "a", attrs: { "data-id": "x" } },
							{
								tag: "div",
								class: 'ok bad"><script>alert(1)</script> also-ok',
								attrs: {
									onclick: "alert(1)",
									style: "position:fixed",
									"data-id": "3000001",
									id: "top",
									href: "javascript:alert(1)",
								},
								lead: [{ tag: "iframe", class: "x" }],
							},
						],
						widgets: {},
					},
				},
				text("p", "Kept"),
			]),
		);
		expect(hostile).toBe('<div class="ok also-ok" data-id="3000001" id="top"><p>Kept</p></div>');
		// a widget's block class is drawn by WpShellBlock with class characters only
		const titled = squash(
			await render([
				{
					_type: "elementor-section",
					_key: "el-3000002",
					skeleton: {
						wraps: [],
						widgets: {
							"3000003": {
								wraps: [],
								blockClass: 'title" onclick="alert(1)" x="  elementor-size-default',
							},
						},
					},
				},
				text("el-3000003", "Heading", "h2"),
			]),
		);
		expect(titled).toBe('<h2 class="elementor-size-default">Heading</h2>');
	});

	it("draws the words a widget's blocks hold, never its empty elements in their place", async () => {
		// a divider drawn with its text keeps its words; the line it would draw alone is not drawn over them
		const html = squash(
			await render([
				{
					_type: "elementor-section",
					_key: "el-4000001",
					skeleton: {
						wraps: [],
						widgets: {
							"4000002": widget("4000002", "divider", {
								body: [
									wrap("div", "elementor-divider"),
									wrap("span", "elementor-divider-separator"),
								],
							}),
							"4000003": widget("4000003", "text-editor"),
						},
					},
				},
				text("el-4000002", "Or"),
				{ _type: "break", _key: "el-4000002-1", style: "lineBreak" },
				{ _type: "elementor-widget", _key: "el-4000003" },
			]),
		);
		expect(html).toContain("<p>Or</p>");
		expect(html).not.toContain("elementor-divider-separator");
		// a widget that kept only its place draws its own elements, empty, and no placeholder of EmDash's
		expect(html).toContain(
			'data-widget_type="text-editor.default"><div class="elementor-widget-container"></div></div>',
		);
		expect(html).not.toContain("data-portabletext-unknown");
	});

	it("leaves a body with no skeleton to EmDash's own drawing, and an owner's EmDash columns block as EmDash draws it", async () => {
		expect(skeletonTree([text("a", "Plain")] as never)).toEqual([{ blocks: [text("a", "Plain")] }]);
		const html = squash(
			await render([
				BODY[0],
				{
					_type: "columns",
					_key: "own",
					columns: [{ _type: "column", _key: "c", content: [text("x", "In a column")] }],
				},
			]),
		);
		expect(html).toContain('class="emdash-columns"');
		expect(html).toContain("In a column");
	});
});

/**
 * A static site's front page of sections, as Embark's import stores its own
 * layout (packages/host/src/import/layout-pt.ts): a carrier per section, each
 * leaf's blocks keyed by the leaf, and every element between the section and a
 * leaf a wrap naming its node, so two leaves of one list item are drawn in one
 * item. All data synthetic (sections.example).
 */
describe("a page's own layout in the WpShell skeleton", () => {
	const node = (tag: string, cls: string, id: string) => ({ ...wrap(tag, cls), node: id });
	const content = node("div", "content-section__content work-list", "n1");
	const item = (id: string) => node("div", "work-list__item", id);
	const left = (id: string) => node("div", "work-list__left", id);
	const image = (key: string, url: string) => ({
		_type: "image",
		_key: key,
		asset: { _type: "reference", _ref: url, url },
		alt: "Logo",
		link: "https://seedco.example/",
	});
	const LAYOUT = [
		{
			_type: "layout-section",
			_key: "ls-0",
			skeleton: {
				wraps: [wrap("section", "content-section work-section", { id: "work" })],
				widgets: {
					l0: {
						wraps: [node("aside", "content-section__aside", "n0")],
						blockClass: "content-section__title",
					},
					l1: { wraps: [content, item("n2"), left("n3")], blockClass: "work-list__logo" },
					l2: {
						wraps: [content, item("n2"), left("n3")],
						blockTag: "span",
						blockClass: "work-list__company",
					},
					l3: { wraps: [content, item("n2")], body: [wrap("span", "work-list__dots")] },
					l4: { wraps: [content, item("n2")], blockTag: "span", blockClass: "work-list__dates" },
					l5: {
						wraps: [content, item("n4"), left("n5")],
						blockTag: "span",
						blockClass: "work-list__company",
					},
					l6: { wraps: [content, item("n4")], blockTag: "span", blockClass: "work-list__dates" },
				},
				added: { wraps: [] },
			},
		},
		text("el-l0", "Work", "h3"),
		image("el-l1", "https://sections.example/logo.png"),
		text("el-l2", "Seed Cooperative"),
		{ _type: "layout-element", _key: "el-l3" },
		text("el-l4", "Grower, 2020 - now"),
		text("el-l5", "Greenhouse Volunteer"),
		text("el-l6", "2015 - 2020"),
		text("owner-added", "An owner's line."),
	];

	it("draws one element per node, each leaf in it in order, as the page drew them", async () => {
		const html = squash(await render(LAYOUT));
		expect(html).toBe(
			'<section class="content-section work-section" id="work">' +
				'<aside class="content-section__aside"><h3 class="content-section__title">Work</h3></aside>' +
				'<div class="content-section__content work-list">' +
				'<div class="work-list__item"><div class="work-list__left">' +
				'<a href="https://seedco.example/"><img class="work-list__logo" src="https://sections.example/logo.png" alt="Logo" loading="lazy" decoding="async"></a>' +
				'<span class="work-list__company">Seed Cooperative</span></div>' +
				'<span class="work-list__dots"></span><span class="work-list__dates">Grower, 2020 - now</span></div>' +
				'<div class="work-list__item"><div class="work-list__left"><span class="work-list__company">Greenhouse Volunteer</span></div>' +
				'<span class="work-list__dates">2015 - 2020</span></div></div>' +
				"<p>An owner&#39;s line.</p>" +
				"</section>",
		);
	});

	it("draws a classed picture's link as the admin's editor stores it, an object, as it draws the import's string", async () => {
		// The import stores a linked image's link as a string; a save in the admin rewrites it as `{ href, blank? }`.
		const withLink = (link: unknown) =>
			LAYOUT.map((b) => (b._key === "el-l1" ? { ...b, link } : b));
		const logo = (html: string) =>
			html.match(
				/<a\b[^>]*><img class="work-list__logo"[^>]*><\/a>|<img class="work-list__logo"[^>]*>/,
			)?.[0];
		const imported = logo(squash(await render(LAYOUT)));
		expect(imported).toMatch(/^<a href="https:\/\/seedco\.example\/"><img class="work-list__logo"/);
		expect(logo(squash(await render(withLink({ href: "https://seedco.example/" }))))).toBe(
			imported,
		);
		// "open in a new tab", as EmDash's own image draws it
		expect(
			logo(squash(await render(withLink({ href: "https://seedco.example/", blank: true })))),
		).toMatch(
			/^<a href="https:\/\/seedco\.example\/" target="_blank" rel="noopener noreferrer"><img class="work-list__logo"/,
		);
		// a link the page cannot follow safely, in either shape, draws the picture alone
		for (const bad of [
			"javascript:alert(1)",
			{ href: "javascript:alert(1)" },
			{ href: "//elsewhere.example/" },
			{ href: "" },
			{ blank: true },
		]) {
			expect(logo(squash(await render(withLink(bad))))).toMatch(/^<img class="work-list__logo"/);
		}
	});

	it("never merges elements that name no node, and draws a heading as a heading whatever its tag says", async () => {
		const html = squash(
			await render([
				{
					_type: "layout-section",
					_key: "ls-0",
					skeleton: {
						wraps: [],
						widgets: {
							a: { wraps: [wrap("div", "row")] },
							b: { wraps: [wrap("div", "row")], blockTag: "span" },
						},
					},
				},
				text("el-a", "One"),
				text("el-b", "Two", "h2"),
			]),
		);
		expect(html).toBe('<div class="row"><p>One</p></div><div class="row"><h2>Two</h2></div>');
	});
});
