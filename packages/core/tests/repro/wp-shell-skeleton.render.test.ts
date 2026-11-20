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
import WpShellLink from "../../../../templates/blog-cloudflare/src/components/WpShellLink.astro";
import WpShellNote from "../../../../templates/blog-cloudflare/src/components/WpShellNote.astro";
import WpShellSkeleton from "../../../../templates/blog-cloudflare/src/components/WpShellSkeleton.astro";
import {
	hasSkeleton,
	skeletonTree,
} from "../../../../templates/blog-cloudflare/src/utils/wp-skeleton";

const components = {
	block: WpShellBlock,
	type: { image: WpShellImage },
	mark: { link: WpShellLink, wpShellNote: WpShellNote },
};
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

/**
 * What a page's own layout drew on its words and links that Portable Text
 * holds no field for, as the import keeps it in a widget's skeleton
 * (packages/host/src/import/layout-pt.ts): a link's class by its href, a hover
 * text with the words it is on, and a whole element that is one link. A save
 * in the admin keeps a block's key and its words, so these are drawn from the
 * skeleton, never stored on the blocks. All data synthetic.
 */
describe("what a page's own layout drew on its words and links", () => {
	const span = (key: string, t: string, marks: string[] = []) => ({
		_type: "span",
		_key: key,
		text: t,
		marks,
	});
	const carrier = (widgets: Record<string, unknown>) => ({
		_type: "layout-section",
		_key: "ls-0",
		skeleton: { wraps: [wrap("section", "content-section")], widgets, added: { wraps: [] } },
	});
	const NOTES = [
		{ text: "a startup called Seedco", title: 'A cooperative of "growers"', class: "citation" },
		{ text: "CSA", title: "Community Supported Agriculture" },
	];
	const after = {
		_type: "block",
		_key: "el-l1-2",
		style: "normal",
		markDefs: [{ _type: "link", _key: "farm", href: "https://farms.example/" }],
		children: [
			span("a", "After, at a startup called "),
			span("b", "Seedco", ["strong"]),
			span("c", ", and CSA boxes, from "),
			span("d", "the farm", ["farm"]),
			span("e", "."),
		],
	};
	const badge = (link: unknown) => ({
		_type: "image",
		_key: "el-l1-1",
		asset: { _type: "reference", _ref: "badge", url: "https://badges.example/badge.svg" },
		link,
	});
	const page = (
		link: unknown = "https://badges.example/robin",
		widgets: Record<string, unknown> = {},
	) => [
		carrier({
			l0: {
				wraps: [wrap("aside", "content-section__aside")],
				blockTag: "none",
				linkClasses: { "https://profiles.example/robin": "content-section__link" },
			},
			l1: {
				wraps: [wrap("div", "intro-text")],
				linkClasses: { "https://badges.example/robin": "badge-widget" },
				notes: NOTES,
			},
			...widgets,
		}),
		{
			_type: "block",
			_key: "el-l0",
			style: "normal",
			markDefs: [{ _type: "link", _key: "p", href: "https://profiles.example/robin" }],
			children: [span("s", "Profile", ["p"])],
		},
		text("el-l1", "Before the badge."),
		badge(link),
		after,
	];

	it("draws a whole element that is one link as that link, with its class, in no paragraph", async () => {
		const html = squash(await render(page()));
		expect(html).toContain(
			'<aside class="content-section__aside"><a href="https://profiles.example/robin" class="content-section__link">Profile</a></aside>',
		);
		// A link the widget names no class for is EmDash's own.
		expect(html).toContain('from <a href="https://farms.example/">the farm</a>.');
	});

	it("draws a picture's link with its class, the picture in it as the page drew it, in either shape of link", async () => {
		const drawn =
			'<a href="https://badges.example/robin" class="badge-widget"><img src="https://badges.example/badge.svg" alt loading="lazy" decoding="async"></a>';
		expect(squash(await render(page()))).toContain(`<p>Before the badge.</p>${drawn}<p>`);
		expect(squash(await render(page({ href: "https://badges.example/robin" })))).toContain(drawn);
		expect(
			squash(await render(page({ href: "https://badges.example/robin", blank: true }))),
		).toContain(
			'<a href="https://badges.example/robin" target="_blank" rel="noopener noreferrer" class="badge-widget"><img',
		);
		// A picture whose link names no class is EmDash's own.
		const other = squash(await render(page("https://elsewhere.example/")));
		expect(other).not.toContain("badge-widget");
		expect(other).toContain("<figure");
	});

	it("draws a picture's link with the title the page drew on it, by its href, with or without its class", async () => {
		const titles = { linkTitles: { "https://badges.example/robin": 'Robin\'s "badge"' } };
		const withTitle = (link: unknown, l1: Record<string, unknown>) =>
			page(link).map((b) =>
				b._type === "layout-section"
					? carrier({
							...(b.skeleton as { widgets: Record<string, unknown> }).widgets,
							l1: { wraps: [wrap("div", "intro-text")], ...l1 },
						})
					: b,
			);
		const img =
			'<img src="https://badges.example/badge.svg" alt loading="lazy" decoding="async"></a>';
		// With its class, in either shape of link.
		for (const link of ["https://badges.example/robin", { href: "https://badges.example/robin" }])
			expect(
				squash(
					await render(
						withTitle(link, {
							linkClasses: { "https://badges.example/robin": "badge-widget" },
							...titles,
						}),
					),
				),
			).toContain(
				`<a href="https://badges.example/robin" class="badge-widget" title="Robin's &quot;badge&quot;">${img}`,
			);
		// A link with a title and no class is drawn as the page drew it too: the picture in its link, with its title.
		const titledOnly = squash(await render(withTitle(undefined, titles)));
		expect(titledOnly).toContain(
			`<a href="https://badges.example/robin" title="Robin's &quot;badge&quot;">${img}`,
		);
		expect(titledOnly).not.toContain("<figure");
		// A title for another href is not this picture's.
		const other = squash(
			await render(withTitle(undefined, { linkTitles: { "https://elsewhere.example/": "x" } })),
		);
		expect(other).not.toContain('title="x"');
		expect(other).toContain("<figure");
	});

	it("draws each hover text on the words it is on, across the spans they are in, and leaves words it does not find alone", async () => {
		const html = squash(await render(page()));
		expect(html).toContain(
			'<p>After, at <span class="citation" title="A cooperative of &quot;growers&quot;">a startup called <strong>Seedco</strong></span>, and <span title="Community Supported Agriculture">CSA</span> boxes, from <a href="https://farms.example/">the farm</a>.</p>',
		);
		// The owner changed the words: no note is drawn, and every word is.
		const edited = page().map((b) =>
			b._key === "el-l1-2" ? { ...after, children: [span("a", "New words, and CSA.")] } : b,
		);
		expect(squash(await render(edited))).toContain(
			'<p>New words, and <span title="Community Supported Agriculture">CSA</span>.</p>',
		);
	});

	// The admin's editor saves a span with no marks as a span with no `marks`, and a block with no links with no `markDefs`.
	it("draws each hover text on a block the admin's editor saved, whose plain spans name no marks", async () => {
		const { marks: _drop, ...bare } = span("a", "After, at a startup called ");
		const saved = page().map((b) =>
			b._key === "el-l1-2"
				? {
						_type: "block",
						_key: "el-l1-2",
						style: "normal",
						children: [
							bare,
							span("b", "Seedco", ["strong"]),
							{ _type: "span", _key: "c", text: ", and CSA boxes." },
						],
					}
				: b,
		);
		expect(squash(await render(saved))).toContain(
			'<p>After, at <span class="citation" title="A cooperative of &quot;growers&quot;">a startup called <strong>Seedco</strong></span>, and <span title="Community Supported Agriculture">CSA</span> boxes.</p>',
		);
	});

	// The admin's editor keeps only a link's href and target, so a link's title rides in the skeleton by its href.
	it("draws a link's title the page drew, by its href, on a text link, as the import stored it and as a save in the admin did", async () => {
		const titled = (link: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
			...page(undefined, {
				l2: {
					wraps: [wrap("div", "more")],
					linkTitles: {
						"https://media.example/": 'Media "home"',
						"https://plain.example/": "",
						"https://odd.example/": 7,
					},
					...extra,
				},
			}),
			{
				_type: "block",
				_key: "el-l2",
				style: "normal",
				markDefs: [
					link,
					{ _type: "link", _key: "o", href: "https://odd.example/" },
					{ _type: "link", _key: "p", href: "https://plain.example/" },
				],
				children: [
					span("a", "Media", ["m"]),
					span("b", ", "),
					span("c", "odd", ["o"]),
					span("d", " and "),
					span("e", "plain", ["p"]),
				],
			},
		];
		const want =
			'<div class="more"><p><a href="https://media.example/" title="Media &quot;home&quot;">Media</a>, <a href="https://odd.example/">odd</a> and <a href="https://plain.example/">plain</a></p></div>';
		expect(
			squash(await render(titled({ _type: "link", _key: "m", href: "https://media.example/" }))),
		).toContain(want);
		// With a class for the same href, the link wears both.
		expect(
			squash(
				await render(
					titled(
						{ _type: "link", _key: "m", href: "https://media.example/", blank: true },
						{ linkClasses: { "https://media.example/": "pill" } },
					),
				),
			),
		).toContain(
			'<a href="https://media.example/" target="_blank" rel="noopener noreferrer" class="pill" title="Media &quot;home&quot;">Media</a>',
		);
	});

	it("draws no class, title or element of its own from a stored value it does not allow", async () => {
		const html = squash(
			await render([
				carrier({
					l0: {
						wraps: [],
						blockTag: "script",
						linkClasses: { "https://profiles.example/robin": 'x" onclick="alert(1)' },
						notes: [
							{ text: "Profile", title: '"><script>alert(1)</script>', class: "a b<c" },
							{ text: "Profile", title: 7 },
						],
					},
				}),
				{
					_type: "block",
					_key: "el-l0",
					style: "normal",
					markDefs: [{ _type: "link", _key: "p", href: "javascript:alert(1)" }],
					children: [span("s", "Profile", ["p"])],
				},
			]),
		);
		expect(html).not.toContain("onclick");
		expect(html).toMatch(/<a href="#">/);
		// The title is one attribute value: its quote is escaped, so nothing in it is markup.
		expect(html).toContain(
			'<span class="a" title="&quot;><script>alert(1)</script>">Profile</span>',
		);
		// A heading stays a heading whatever the widget's tag says.
		const heading = squash(
			await render([
				carrier({ l0: { wraps: [], blockTag: "none" } }),
				text("el-l0", "Title", "h2"),
			]),
		);
		expect(heading).toBe('<section class="content-section"><h2>Title</h2></section>');
	});

	// A page that drew two hover texts on the same words, each where it stood (a glossary's "CSA" twice), keeps each on its
	// own words: the second is drawn on the next place the words are found, never on top of the first.
	it("draws two hover texts on the same words each on its own place, in the order the page drew them", async () => {
		const html = squash(
			await render([
				carrier({
					l0: {
						wraps: [],
						notes: [
							{ text: "CSA", title: "one" },
							{ text: "CSA", title: "two" },
						],
					},
				}),
				{
					_type: "block",
					_key: "el-l0",
					style: "normal",
					markDefs: [],
					children: [span("a", "CSA and CSA")],
				},
				{
					_type: "block",
					_key: "el-l0-1",
					style: "normal",
					markDefs: [],
					children: [span("b", "CSA again")],
				},
			]),
		);
		expect(html).toContain(
			'<p><span title="one">CSA</span> and <span title="two">CSA</span></p><p>CSA again</p>',
		);
	});

	// A hover text's mark is named apart from every mark the block holds, so it never takes another mark's place.
	it("names a hover text's mark apart from the marks a block holds", async () => {
		const html = squash(
			await render([
				carrier({ l0: { wraps: [], notes: [{ text: "x", title: "T" }] } }),
				{
					_type: "block",
					_key: "el-l0",
					style: "normal",
					markDefs: [{ _type: "link", _key: "wp-shell-note-0", href: "https://x.example/" }],
					children: [span("a", "x y", ["wp-shell-note-0"])],
				},
			]),
		);
		expect(html).toContain('<a href="https://x.example/"><span title="T">x</span> y</a>');
	});
});
