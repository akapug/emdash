import { describe, expect, it, vi } from "vitest";

import {
	bodyClassFor,
	classicVideoEmbed,
	composeWpShell,
	featuredDrawn,
	formatWpDate,
	formSkin,
	imageRatio,
	isCurrent,
	laneHeight,
	layoutFor,
	listingExcerpt,
	ownImagePath,
	parseWpShell,
	parseWpShellCached,
	plainText,
	renderListing,
	renderMenu,
	renderWpShellForm,
	safeHref,
	wpShellDocumentTitle,
	wpShellPostFill,
	wpShellProblem,
	wpShellRoute,
	type WpShell,
	type WpShellForm,
	type WpShellFormDefinition,
	type WpShellListing,
	type WpShellMenu,
	type WpShellPageLayout,
	type WpShellPost,
	type WpShellPostFill,
	type WpShellPostLayout,
} from "../../../../../templates/blog-cloudflare/src/utils/wp-shell";
import writerRecords from "./wp-shell-writer-records.json";

/** A front page's own layout: its highlights, around the title and content, and the record's menu. */
function homeOf(): NonNullable<WpShell["home"]> {
	return {
		body: { class: "home page-template-template-single-column front-page one-column" },
		styles: ["/_emdash/api/media/file/wp-shell/front1.css"],
		parts: [
			{ html: '<header id="site-header"><nav><ul class="primary-menu">' },
			{ slot: "menu", menu: 0 },
			{
				html: '</ul></nav></header><div class="highlights static-front-page"><div class="container">',
			},
			{ slot: "title", tag: "h2", class: "highlight-title" },
			{ slot: "content", tag: "div" },
			{ html: "</div></div><footer></footer>" },
		],
	};
}

/** A Twenty Twenty shaped record, as Embark's writer produces it. */
function sample(): WpShell {
	const menu: WpShellMenu = {
		location: "primary",
		leaf: [
			'<li class="menu-item',
			{ s: "cls" },
			'"><a href="',
			{ s: "href" },
			'">',
			{ s: "label" },
			"</a></li>",
		],
		parent: [
			'<li class="menu-item menu-item-has-children',
			{ s: "cls" },
			'"><a href="',
			{ s: "href" },
			'">',
			{ s: "label" },
			'</a><span class="icon"></span><ul class="sub-menu">',
			{ s: "children" },
			"</ul></li>",
		],
		fallback: '<li class="menu-item"><a href="/about/">About</a></li>',
	};
	return {
		version: 1,
		id: "0123456789abcdef01234567",
		source: { url: "https://example.org/", capturedAt: "2026-09-26T00:00:00.000Z" },
		html: { lang: "en-US", class: "no-js" },
		body: { class: "wp-singular wp-theme-twentytwenty singular enable-search-modal" },
		styles: ["/_emdash/api/media/file/wp-shell/abc123.css"],
		parts: [
			{ html: '<header id="site-header"><div class="site-title faux-heading"><a href="/">' },
			{ slot: "siteTitle", fallback: "Example & Co" },
			{ html: '</a></div><div class="site-description">' },
			{ slot: "tagline", fallback: "Captured tagline" },
			{ html: '</div><nav><ul class="primary-menu reset-list-style">' },
			{ slot: "menu", menu: 0 },
			{
				html: '</ul></nav></header><main id="site-content"><article class="page type-page"><header class="entry-header">',
			},
			{ slot: "title", tag: "h1", class: "entry-title" },
			{ html: '</header><div class="post-inner thin">' },
			{ slot: "content", tag: "div", class: "entry-content" },
			{ html: '</div></article></main><footer id="site-footer"></footer>' },
		],
		menus: [menu],
	};
}

describe("wp-shell record", () => {
	it("accepts the record the writer produces", () => {
		expect(wpShellProblem(sample())).toBeNull();
		expect(parseWpShell(sample())).toEqual(sample());
	});

	it("is absent, not an error, when the site has none", () => {
		expect(parseWpShell(undefined)).toBeNull();
	});

	const refused: Array<[string, (s: WpShell) => void]> = [
		["another version", (s) => void ((s as { version: number }).version = 2)],
		["a script", (s) => void s.parts.unshift({ html: "<script>alert(1)</script>" })],
		["a script written with a space", (s) => void s.parts.unshift({ html: "< script src=x>" })],
		[
			"an event handler",
			(s) => void s.parts.unshift({ html: '<img src="/x.png" onerror="alert(1)">' }),
		],
		[
			"an event handler after a slash",
			(s) => void s.parts.unshift({ html: "<img/onerror=alert(1) src=x>" }),
		],
		[
			"an event handler after a quoted value",
			(s) => void s.parts.unshift({ html: '<img src="x"onerror=alert(1)>' }),
		],
		[
			"a javascript: link",
			(s) => void s.parts.unshift({ html: '<a href=" javascript:alert(1)">x</a>' }),
		],
		[
			"an iframe",
			(s) => void s.parts.unshift({ html: '<iframe src="https://evil.example"></iframe>' }),
		],
		[
			"a stylesheet in the body",
			(s) =>
				void s.parts.unshift({ html: '<link rel="stylesheet" href="https://evil.example/x.css">' }),
		],
		["a style element", (s) => void s.parts.unshift({ html: "<style>body{}</style>" })],
		[
			"a stylesheet on another host",
			(s) => void (s.styles = ["https://old-host.example/style.css"]),
		],
		[
			"a stylesheet outside wp-shell/",
			(s) => void (s.styles = ["/_emdash/api/media/file/other.css"]),
		],
		["two title slots", (s) => void s.parts.push({ slot: "title", tag: "h1" })],
		[
			"no content slot",
			(s) => void (s.parts = s.parts.filter((p) => !("slot" in p) || p.slot !== "content")),
		],
		[
			"a title tag it does not draw",
			(s) => void s.parts.splice(7, 1, { slot: "title", tag: "script" as "h1" }),
		],
		[
			"a class that leaves its attribute",
			(s) => void s.parts.splice(7, 1, { slot: "title", tag: "h1", class: 'x" onclick="y' }),
		],
		["a body class that leaves its attribute", (s) => void (s.body.class = 'x" onload="y')],
		["a menu slot naming no menu", (s) => void s.parts.push({ slot: "menu", menu: 3 })],
		[
			"a menu link outside an href",
			(s) => void (s.menus[0]!.leaf = ["<li>", { s: "href" }, "</li>"]),
		],
		[
			"executable markup in a menu template",
			(s) => void s.menus[0]!.leaf.unshift('<a onmouseover="x">'),
		],
		[
			"executable markup in a menu fallback",
			(s) => void (s.menus[0]!.fallback = "<script>x</script>"),
		],
		[
			"a logo from another host",
			(s) => void s.parts.push({ slot: "logo", src: "https://old-host.example/logo.png" }),
		],
		[
			"a menu's current classes that leave their attribute",
			(s) => void (s.menus[0]!.current = 'x" onclick="y'),
		],
		// the front page's layout is checked as the record's own is
		["a home layout that is not an object", (s) => void ((s as { home: unknown }).home = "home")],
		[
			"a script in the home layout",
			(s) =>
				void (s.home = {
					...homeOf(),
					parts: [{ html: "<script>alert(1)</script>" }, ...homeOf().parts],
				}),
		],
		[
			"a home layout with no content slot",
			(s) =>
				void (s.home = {
					...homeOf(),
					parts: homeOf().parts.filter((p) => !("slot" in p) || p.slot !== "content"),
				}),
		],
		[
			"a home stylesheet on another host",
			(s) => void (s.home = { ...homeOf(), styles: ["https://old-host.example/style.css"] }),
		],
		[
			"a home body class that leaves its attribute",
			(s) => void (s.home = { ...homeOf(), body: { class: 'x" onload="y' } }),
		],
		[
			"a home menu slot naming no menu",
			(s) => void (s.home = { ...homeOf(), parts: [...homeOf().parts, { slot: "menu", menu: 5 }] }),
		],
	];
	for (const [what, spoil] of refused) {
		it(`is refused whole for ${what}`, () => {
			const s = sample();
			spoil(s);
			expect(wpShellProblem(s)).not.toBeNull();
			expect(parseWpShell(s)).toBeNull();
		});
	}

	it("checks a record once per settings object, and says why it refused one", () => {
		const warn = vi.fn();
		const bad = { ...sample(), version: 9 };
		expect(parseWpShellCached(bad, warn)).toBeNull();
		expect(parseWpShellCached(bad, warn)).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toMatch(/version/);
		const good = sample();
		expect(parseWpShellCached(good, warn)).toBe(good);
		expect(parseWpShellCached("<script>", warn)).toBeNull();
	});
});

describe("wp-shell menus", () => {
	const menu = sample().menus[0]!;

	it("draws the EmDash menu in the theme's markup, escaped, with the current item marked", () => {
		const html = renderMenu(
			menu,
			[
				{ label: "Home", url: "/", children: [] },
				{
					label: "History <&>",
					url: "/pages/history",
					children: [{ label: 'Pioneers "1"', url: "/pages/pioneer?x=1&y=2", children: [] }],
				},
				{ label: "Elsewhere", url: "https://other.example/", target: "_blank", children: [] },
			],
			"/pages/history/",
		);
		expect(html).toBe(
			'<li class="menu-item"><a href="/">Home</a></li>' +
				'<li class="menu-item menu-item-has-children current-menu-item"><a href="/pages/history">History &lt;&amp;&gt;</a>' +
				'<span class="icon"></span><ul class="sub-menu">' +
				'<li class="menu-item"><a href="/pages/pioneer?x=1&amp;y=2">Pioneers "1"</a></li></ul></li>' +
				'<li class="menu-item"><a href="https://other.example/" target="_blank" rel="noopener noreferrer">Elsewhere</a></li>',
		);
	});

	it("never draws a link that runs script", () => {
		const html = renderMenu(menu, [{ label: "x", url: "javascript:alert(1)", children: [] }], "/");
		expect(html).toBe('<li class="menu-item"><a href="#">x</a></li>');
		expect(safeHref(" java\tscript:x")).toBe("#");
		expect(safeHref("data:text/html,x")).toBe("#");
		expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
		expect(safeHref("/a")).toBe("/a");
		expect(safeHref("//other.example/")).toBe("//other.example/");
	});

	it("keeps the captured items while the site has no such EmDash menu", () => {
		expect(renderMenu(menu, null, "/")).toBe(menu.fallback);
	});

	it("marks only a path on this site as current", () => {
		expect(isCurrent("/about/", "/about")).toBe(true);
		expect(isCurrent("/about#team", "/about")).toBe(true);
		expect(isCurrent("/", "/")).toBe(true);
		expect(isCurrent("/", "/about")).toBe(false);
		expect(isCurrent("https://example.org/about", "/about")).toBe(false);
		expect(isCurrent("//example.org/about", "/about")).toBe(false);
	});
});

describe("wp-shell layout pieces", () => {
	it("fills the site title, tagline and menu, and leaves the title and content to the layout", () => {
		const pieces = composeWpShell(sample(), {
			siteTitle: "Pah <Tempe>",
			tagline: undefined,
			menuItems: () => [{ label: "Home", url: "/", children: [] }],
			currentPath: "/",
		});
		expect(pieces.map((p) => Object.keys(p)[0])).toEqual([
			"html",
			"title",
			"html",
			"content",
			"html",
		]);
		const first = (pieces[0] as { html: string }).html;
		expect(first).toContain("Pah &lt;Tempe&gt;");
		expect(first).toContain("Captured tagline");
		expect(first).toContain('<li class="menu-item current-menu-item"><a href="/">Home</a></li>');
		expect(pieces[1]).toEqual({ title: { tag: "h1", class: "entry-title" } });
		expect(pieces[3]).toEqual({ content: { tag: "div", class: "entry-content" } });
	});

	it("uses the captured site title when the setting is unset", () => {
		const pieces = composeWpShell(sample(), { menuItems: () => null, currentPath: "/" });
		expect((pieces[0] as { html: string }).html).toContain("Example &amp; Co");
	});

	it("draws the logo setting over the captured logo", () => {
		const s = sample();
		s.parts.unshift({
			slot: "logo",
			src: "/_emdash/api/media/file/wp-shell/logo1.png",
			alt: "Logo",
			class: "custom-logo",
			width: 120,
			height: 40,
		});
		const drawn = (fill: { logoUrl?: string | null }) =>
			(
				composeWpShell(s, { ...fill, menuItems: () => null, currentPath: "/" })[0] as {
					html: string;
				}
			).html;
		expect(drawn({})).toMatch(
			/^<img src="\/_emdash\/api\/media\/file\/wp-shell\/logo1.png" alt="Logo" class="custom-logo" width="120" height="40">/,
		);
		expect(drawn({ logoUrl: "/_emdash/api/media/file/new.png" })).toMatch(
			/^<img src="\/_emdash\/api\/media\/file\/new.png"/,
		);
		expect(drawn({ logoUrl: "javascript:x" })).toMatch(
			/^<img src="\/_emdash\/api\/media\/file\/wp-shell\/logo1.png"/,
		);
	});

	it("gives each kind of page WordPress's body classes for it", () => {
		const s = sample();
		s.body.class = "home page page-template-default wp-theme-twentytwenty singular";
		expect(bodyClassFor(s, "home")).toBe(
			"home page page-template-default wp-theme-twentytwenty singular",
		);
		expect(bodyClassFor(s, "page")).toBe(
			"page page-template-default wp-theme-twentytwenty singular",
		);
		expect(bodyClassFor(s, "post")).toBe(
			"single single-post single-format-standard wp-theme-twentytwenty singular",
		);
	});
});

describe("wp-shell: the chrome that prints the title, and the front page's own layout", () => {
	it("draws the entry title, escaped, where the chrome prints it as text", () => {
		const s = sample();
		s.parts.unshift(
			{ html: '<div class="breadcrumbs"><a href="/" class="home">' },
			{ slot: "siteTitle", fallback: "Example" },
			{ html: "</a> &gt; <span>" },
			{ slot: "titleText" },
			{ html: "</span></div>" },
		);
		expect(wpShellProblem(s)).toBeNull();
		const first = (
			composeWpShell(s, {
				menuItems: () => null,
				currentPath: "/pages/team",
				title: "Our <Team> & Co",
			})[0] as { html: string }
		).html;
		expect(first).toMatch(
			/^<div class="breadcrumbs"><a href="\/" class="home">Example<\/a> &gt; <span>Our &lt;Team&gt; &amp; Co<\/span><\/div>/,
		);
	});

	it("draws the home from the front page's layout, and every other page from the record's", () => {
		const s = sample();
		s.home = homeOf();
		expect(wpShellProblem(s)).toBeNull();
		const kinds = (kind: "home" | "page") =>
			composeWpShell(s, { menuItems: () => null, currentPath: "/", kind }).map((p) =>
				"html" in p ? "html" : Object.keys(p)[0],
			);
		const home = composeWpShell(s, { menuItems: () => null, currentPath: "/", kind: "home" });
		expect(home[1]).toEqual({ title: { tag: "h2", class: "highlight-title" } });
		expect(home[2]).toEqual({ content: { tag: "div" } });
		expect((home[0] as { html: string }).html).toContain(
			'<div class="highlights static-front-page">',
		);
		expect(kinds("page")).toEqual(["html", "title", "html", "content", "html"]);
		expect(layoutFor(s, "home").styles).toEqual(["/_emdash/api/media/file/wp-shell/front1.css"]);
		expect(layoutFor(s, "page").styles).toEqual(s.styles);
		expect(bodyClassFor(s, "home")).toBe(
			"home page-template-template-single-column front-page one-column",
		);
		expect(bodyClassFor(s, "page")).toBe(
			"page page-template-default wp-singular wp-theme-twentytwenty singular enable-search-modal",
		);
		// no home layout: the home is the record's own
		expect(layoutFor(sample(), "home").parts).toEqual(sample().parts);
	});

	it("marks the current menu item with the classes the theme gives it", () => {
		const menu = { ...sample().menus[0]!, current: "current-menu-item current_page_item active" };
		expect(renderMenu(menu, [{ label: "Home", url: "/", children: [] }], "/")).toBe(
			'<li class="menu-item current-menu-item current_page_item active"><a href="/">Home</a></li>',
		);
	});
});

/** Franz Josef's highlights: one item's markup as Embark's writer cuts it. */
function listingOf(): WpShellListing {
	return {
		count: 3,
		item: [
			'<div class="',
			{ s: "cls" },
			'"><div class="item clearfix post hentry">',
			{ s: "thumb" },
			'<h3 class="item-title"><a href="',
			{ s: "href" },
			'">',
			{ s: "title" },
			'</a></h3><div class="excerpt"><p>',
			{ s: "excerpt" },
			'</p></div><p class="date"><a href="',
			{ s: "href" },
			'">',
			{ s: "date" },
			'</a></p><p class="comments-count"><a href="',
			{ s: "href" },
			'#respond">Leave a reply</a></p></div></div>',
		],
		thumb: [
			'<a href="',
			{ s: "href" },
			'"><img alt="" src="',
			{ s: "src" },
			'" class="attachment-medium wp-post-image"></a>',
		],
		classes: ["item-wrap col-md-12", "item-wrap col-md-3 col-sm-6"],
		date: "F j, Y",
		utcOffset: -480,
		excerpt: { words: 5, more: " [\u2026]" },
	};
}

/** The sample's front page, with the latest posts listed below its content. */
function withListing(listing: WpShellListing = listingOf()): WpShell {
	const s = sample();
	const home = homeOf();
	return {
		...s,
		listings: [listing],
		home: {
			...home,
			parts: [
				...home.parts.slice(0, -1),
				{ html: '<div class="row items-container">' },
				{ slot: "listing", listing: 0 },
				{ html: "</div><footer></footer>" },
			],
		},
	};
}

const POSTS: WpShellPost[] = [
	{
		title: "Tom & Jerry's <b>news</b>",
		url: "/posts/news",
		excerpt: "",
		text: "One two three four five six seven",
		// 05:00 UTC on 12 July is 21:00 on 11 July in UTC-8
		date: new Date("2023-07-12T05:00:00Z"),
		image: "/_emdash/api/media/file/01ABC.png",
	},
	{
		title: "Second",
		url: "/posts/second",
		excerpt: "Its own <excerpt>.",
		date: new Date("2022-12-18T20:00:00Z"),
		image: "https://elsewhere.example/p.png",
	},
	{ title: "Third", url: "/posts/third", text: "Short.", date: null },
	{ title: "Fourth, past the count", url: "/posts/fourth" },
];

describe("wp-shell: the front page's listing of the latest posts", () => {
	it("draws each post in the theme's markup for one item, its text escaped", () => {
		const html = renderListing(listingOf(), POSTS);
		const item = (cls: string, body: string) =>
			`<div class="${cls}"><div class="item clearfix post hentry">${body}</div></div>`;
		const text = (href: string, title: string, excerpt: string, date: string) =>
			`<h3 class="item-title"><a href="${href}">${title}</a></h3><div class="excerpt"><p>${excerpt}</p></div>` +
			`<p class="date"><a href="${href}">${date}</a></p><p class="comments-count"><a href="${href}#respond">Leave a reply</a></p>`;
		expect(html).toBe(
			[
				// the first item's own class; the day WordPress printed, in the site's zone; an excerpt
				// made from the content, cut as WordPress cuts one; the site's own image
				item(
					"item-wrap col-md-12",
					'<a href="/posts/news"><img alt="" src="/_emdash/api/media/file/01ABC.png" class="attachment-medium wp-post-image"></a>' +
						text(
							"/posts/news",
							"Tom &amp; Jerry's &lt;b&gt;news&lt;/b&gt;",
							"One two three four five [\u2026]",
							"July 11, 2023",
						),
				),
				// its own excerpt, escaped; an image from elsewhere is not drawn, nor its link
				item(
					"item-wrap col-md-3 col-sm-6",
					text("/posts/second", "Second", "Its own &lt;excerpt&gt;.", "December 18, 2022"),
				),
				// no date: none printed
				item("item-wrap col-md-3 col-sm-6", text("/posts/third", "Third", "Short.", "")),
				// and only as many as WordPress listed
			].join(""),
		);
	});

	it("prints an excerpt's paragraphs in the item's own <p>s where the theme does, escaped", () => {
		const listing = {
			...listingOf(),
			excerpt: { words: 55, more: " [\u2026]", paragraphs: true as const },
		};
		const html = renderListing(listing, [
			{ title: "T", url: "/posts/t", excerpt: "One <b>.\n\nTwo." },
		]);
		expect(html).toContain('<div class="excerpt"><p>One &lt;b&gt;.</p><p>Two.</p></div>');
		// a hole in no <p> of its own gets one paragraph
		const bare = {
			...listing,
			item: listing.item.map((x) =>
				x === '</a></h3><div class="excerpt"><p>' ? '</a></h3><div class="excerpt">' : x,
			),
		};
		expect(
			renderListing(bare, [{ title: "T", url: "/posts/t", excerpt: "One.\n\nTwo." }]),
		).toContain('<div class="excerpt">One. Two.</p></div>');
		expect(wpShellProblem(withListing(listing))).toBeNull();
		expect(
			wpShellProblem(
				withListing({ ...listing, excerpt: { ...listing.excerpt, paragraphs: "yes" } } as never),
			),
		).not.toBeNull();
	});

	it("draws the listing where the front page's layout has it, from the posts it is given", () => {
		const shell = withListing();
		expect(wpShellProblem(shell)).toBeNull();
		const pieces = composeWpShell(shell, {
			menuItems: () => null,
			currentPath: "/",
			kind: "home",
			posts: POSTS,
		});
		const html = pieces.flatMap((p) => ("html" in p ? [p.html] : [])).join("");
		expect(html).toContain('<div class="row items-container"><div class="item-wrap col-md-12">');
		expect(html.match(/class="item-title"/g)).toHaveLength(3);
		// no posts, no items
		const none = composeWpShell(shell, { menuItems: () => null, currentPath: "/", kind: "home" });
		expect(none.flatMap((p) => ("html" in p ? [p.html] : [])).join("")).toContain(
			'<div class="row items-container"></div>',
		);
	});

	it("prints a date with WordPress's date letters, in the site's zone", () => {
		const d = new Date("2024-03-01T06:30:00Z");
		expect(formatWpDate(d, "F j, Y")).toBe("March 1, 2024");
		expect(formatWpDate(d, "M jS, Y")).toBe("Mar 1st, 2024");
		expect(formatWpDate(d, "Y-m-d", { utcOffset: -480 })).toBe("2024-02-29");
		expect(formatWpDate(d, "d/m/Y", { timeZone: "America/Los_Angeles" })).toBe("29/02/2024");
		expect(formatWpDate(d, "j F Y", { timeZone: "Not/AZone" })).toBe("1 March 2024");
	});

	it("reads a post's text, excerpt and image as the listing draws them", () => {
		expect(
			plainText([
				{ _type: "block", children: [{ text: "One " }, { text: "two" }] },
				{ _type: "image" },
				{ _type: "block", children: [{ text: "three" }] },
			]),
		).toBe("One two\n\nthree");
		const cut = { words: 5, more: " \u2026" };
		const post = (text: string, excerpt = "") => ({ title: "", url: "", text, excerpt });
		expect(listingExcerpt(post("a b c"), { words: 2, more: "\u2026" })).toEqual(["a b\u2026"]);
		expect(listingExcerpt(post("a b"), { words: 2, more: "\u2026" })).toEqual(["a b"]);
		// the words run on across paragraphs, into one unless the theme prints its excerpts' paragraphs
		expect(listingExcerpt(post("a b c\n\nd e f"), cut)).toEqual(["a b c d e \u2026"]);
		expect(listingExcerpt(post("a b c\n\nd e f"), { ...cut, paragraphs: true })).toEqual([
			"a b c",
			"d e \u2026",
		]);
		expect(listingExcerpt(post("a b c\n\nd e"), { ...cut, paragraphs: true })).toEqual([
			"a b c",
			"d e",
		]);
		expect(listingExcerpt(post("a b c d e\n\nf"), { ...cut, paragraphs: true })).toEqual([
			"a b c d e \u2026",
		]);
		// the post's own excerpt, whole, paragraphs and all
		expect(
			listingExcerpt(post("x", "One two three four five six.\n\nSeven."), {
				...cut,
				paragraphs: true,
			}),
		).toEqual(["One two three four five six.", "Seven."]);
		expect(ownImagePath("/_emdash/api/media/file/a.png")).toBe("/_emdash/api/media/file/a.png");
		expect(ownImagePath({ provider: "local", id: "x", src: "/_emdash/api/media/file/b.jpg" })).toBe(
			"/_emdash/api/media/file/b.jpg",
		);
		expect(ownImagePath({ id: "x", meta: { storageKey: "c.webp" } })).toBe(
			"/_emdash/api/media/file/c.webp",
		);
		// a local value with no storage key in its meta: its id, as EmDashMedia reads it
		expect(ownImagePath({ provider: "local", id: "01KSEO.jpg" })).toBe(
			"/_emdash/api/media/file/01KSEO.jpg",
		);
		for (const bad of [
			{ provider: "external", src: "https://example.org/p.png" },
			"/_emdash/api/media/file/../../x.png",
			'/_emdash/api/media/file/a.png" onerror="x',
			null,
		])
			expect(ownImagePath(bad)).toBeNull();
	});

	/** The listing with one field replaced. */
	const listingWith = (patch: Record<string, unknown>) =>
		withListing({ ...listingOf(), ...patch } as WpShellListing);
	const refused: Array<[string, WpShell]> = [
		["a listing slot that names no listing", { ...withListing(), listings: [] }],
		["a count past fifty", listingWith({ count: 51 })],
		["an unknown hole", listingWith({ item: ["<div>", { s: "label" }, "</div>"] })],
		[
			"a title hole inside an attribute",
			listingWith({ item: ['<a title="', { s: "title" }, '">x</a>'] }),
		],
		["an href hole outside an href", listingWith({ item: ["<p>", { s: "href" }, "</p>"] })],
		["a src hole in the item itself", listingWith({ item: ['<img src="', { s: "src" }, '">'] })],
		["a class that is not tokens", listingWith({ classes: ['a" onclick="x'] })],
		["no classes", listingWith({ classes: [] })],
		["a date format with other letters", listingWith({ date: "<b>F</b>" })],
		["a time zone that is not one", listingWith({ timeZone: "../etc" })],
		["an offset past a day", listingWith({ utcOffset: 900 })],
		[
			"a thumbnail that loads from elsewhere",
			listingWith({ thumb: ['<img src="https://tracker.example/p.gif">'] }),
		],
		[
			"executable markup in the item",
			listingWith({ item: ['<div onclick="x">', { s: "title" }, "</div>"] }),
		],
	];
	for (const [what, record] of refused) {
		it(`refuses ${what}`, () => {
			expect(wpShellProblem(record)).not.toBeNull();
		});
	}
});

describe("wp-shell: the document title", () => {
	it("prints a carried SEO title exactly as written, and EmDash's title otherwise", () => {
		expect(
			wpShellDocumentTitle("Our Team | Example & Co", "Example & Co", "Our Team - Example"),
		).toBe("Our Team - Example");
		// no carried title: EmDash's, which getSeoMeta already ended with the site's name
		expect(wpShellDocumentTitle("Our Team | Example & Co", "Example & Co", null)).toBe(
			"Our Team | Example & Co",
		);
		expect(wpShellDocumentTitle("Our Team", "Example & Co")).toBe("Our Team \u2014 Example & Co");
		expect(wpShellDocumentTitle("Example & Co", "Example & Co", "  ")).toBe("Example & Co");
	});
});

describe("wp-shell route", () => {
	it("draws only the three rewritten shapes", () => {
		expect(wpShellRoute("home")).toEqual({ kind: "home" });
		expect(wpShellRoute("pages/about")).toEqual({ kind: "page", slug: "about" });
		expect(wpShellRoute("posts/hello")).toEqual({ kind: "post", slug: "hello" });
		expect(wpShellRoute(undefined)).toBeNull();
		expect(wpShellRoute("tag/x")).toBeNull();
		expect(wpShellRoute("pages/a/b")).toBeNull();
	});
});

/**
 * The reader and the writer agree. These are Embark's builder output for its
 * Twenty Twenty fixture, as written, for the same page with a hostile header
 * and stylesheet, for its Twenty Twenty and Bootstrap toggles (links to a
 * menu's id, a details summary), and for its Franz Josef fixtures with a
 * breadcrumb trail, the front page's own layout and its listing of the latest
 * posts (packages/control-plane/test/wp-shell.test.ts, dumped with
 * WPSHELL_DUMP=1). A tripwire that refused them would put every migrated site
 * back in the template's own design.
 */

describe("the tripwire reads the writer's form", () => {
	it("accepts what Embark's writer produces, hostile source included", () => {
		for (const r of writerRecords) expect(wpShellProblem(r)).toBeNull();
		// the toggles, the sub-menu toggles, the listing, its thumbnail and its lanes, a page cut on
		// its own and a form's skin are among them
		const all = JSON.stringify(writerRecords);
		for (const shape of [
			'<details class=\\"wp-shell-toggle',
			'href=\\"#wp-shell-menu-0\\"',
			"wp-shell-sub",
			'"listings"',
			'"thumb"',
			'"lanes"',
			'"pages"',
			'"forms"',
			'{"s":"control","field":0',
			'"post"',
			'{"slot":"postMeta","meta":0}',
			'{"slot":"trailTerm"}',
			'{"slot":"featured"}',
			'{"slot":"comments","tag":"div","class":"comment-respond","id":"respond"}',
			'{"s":"share-x"}',
			'{"slot":"authorBio"}',
			'{"slot":"adjacent"}',
			'{"s":"adjTitle"}',
			'"many":"%d Comments"',
		])
			expect(all).toContain(shape);
	});

	/** The sample record with one more html part, or with a menu's leaf template replaced. */
	const withHtml = (...html: string[]) => {
		const s = sample();
		return { ...s, parts: [...s.parts, ...html.map((h) => ({ html: h }))] };
	};

	// Each of these is executable, or loads from somewhere else, in a browser;
	// the previous tripwire (three patterns over the raw string) let every one through.
	const forged: Array<[string, unknown]> = [
		["an entity-encoded javascript: link", withHtml('<a href="&#106;avascript:alert(1)">x</a>')],
		["a named-entity colon", withHtml('<a href="javascript&colon;alert(1)">x</a>')],
		["a tab inside the scheme", withHtml('<a href="java&#x09;script:alert(1)">x</a>')],
		["a raw tab inside the scheme", withHtml('<a href="java\tscript:alert(1)">x</a>')],
		[
			"a > inside a quoted value before a handler",
			withHtml('<a title=">" onclick="alert(1)">x</a>'),
		],
		["a quote inside an attribute name", withHtml('<a x"y=1 onclick=alert(1)>x</a>')],
		[
			"a tag cut in two by a slot",
			(() => {
				const s = sample();
				return {
					...s,
					parts: [
						...s.parts,
						{ html: '<img src="/_emdash/api/media/file/a.png" ' },
						{ slot: "tagline", fallback: "" },
						{ html: ' onerror="alert(1)">' },
					],
				};
			})(),
		],
		[
			"a label hole inside an attribute",
			(() => {
				const s = sample();
				const leaf = [
					'<li class="menu-item',
					{ s: "cls" },
					'"><a title="',
					{ s: "label" },
					'" href="',
					{ s: "href" },
					'">x</a></li>',
				];
				return { ...s, menus: s.menus.map((m) => ({ ...m, leaf })) };
			})(),
		],
		[
			"a formaction on a button",
			withHtml('<button form="c" formaction="&#106;avascript:alert(1)">x</button>'),
		],
		[
			"a noscript that hides a tag from a parser with scripting off",
			withHtml('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>'),
		],
		[
			"a data-emdash-ref the editor toolbar would take for the page's own",
			withHtml(
				'<div data-emdash-ref="{&quot;collection&quot;:&quot;posts&quot;,&quot;id&quot;:&quot;p1&quot;,&quot;status&quot;:&quot;draft&quot;}">x</div>',
			),
		],
		["an emdash id", withHtml('<div id="emdash-toolbar">x</div>')],
		["an image from another server", withHtml('<img src="https://tracker.example/p.gif">')],
		["a protocol-relative image", withHtml('<img src="//tracker.example/p.gif">')],
		[
			"a style url to another server",
			withHtml("<div style=\"background:url('https://tracker.example/b.png')\">x</div>"),
		],
		[
			"a CSS-escaped url()",
			withHtml('<div style="background:u\\72 l(https://tracker.example/b.png)">x</div>'),
		],
		[
			"an image-set string",
			withHtml(
				"<div style=\"background-image:image-set('https://tracker.example/b.png' 1x)\">x</div>",
			),
		],
		[
			"a srcset",
			withHtml(
				'<img src="/_emdash/api/media/file/a.png" srcset="https://tracker.example/b.png 2x">',
			),
		],
		["an unquoted attribute", withHtml("<img src=/_emdash/api/media/file/a.png>")],
		["a comment", withHtml("<!--><img src=x onerror=alert(1)>-->")],
	];
	for (const [what, record] of forged) {
		it(`refuses ${what}`, () => {
			expect(wpShellProblem(record)).not.toBeNull();
		});
	}
});

/** A page cut on its own, as Embark's writer cuts one: a contact page on a single-column template. */
function contactOf(): WpShellPageLayout {
	return {
		slug: "contact",
		body: { class: "page-template-template-full-width page page-id-9" },
		styles: ["/_emdash/api/media/file/wp-shell/contact1.css"],
		parts: [
			{ html: '<header id="site-header"><nav><ul class="primary-menu">' },
			{ slot: "menu", menu: 0 },
			{ html: '</ul></nav></header><main class="one-column">' },
			{ slot: "title", tag: "h1", class: "entry-title" },
			{ slot: "content", tag: "div", class: "entry-content" },
			{ html: "</main><footer></footer>" },
		],
	};
}

describe("wp-shell: a page cut on its own, for the EmDash page of its slug", () => {
	const html = (s: WpShell, kind: "page" | "post", slug: string | null) =>
		composeWpShell(s, { menuItems: () => null, currentPath: "/pages/x", kind, slug })
			.flatMap((p) => ("html" in p ? [p.html] : []))
			.join("");

	it("draws that page in its own layout, classes and stylesheets, and every other page in the record's", () => {
		const s = { ...sample(), pages: [contactOf()] };
		expect(wpShellProblem(s)).toBeNull();
		expect(layoutFor(s, "page", "contact").styles).toEqual([
			"/_emdash/api/media/file/wp-shell/contact1.css",
		]);
		expect(bodyClassFor(s, "page", "contact")).toBe(
			"page-template-template-full-width page page-id-9",
		);
		expect(html(s, "page", "contact")).toContain('<main class="one-column">');
		// another page, a page with no slug, and a post of that slug wear the record's layout
		for (const [kind, slug] of [
			["page", "about"],
			["page", null],
			["post", "contact"],
		] as const) {
			expect(layoutFor(s, kind, slug), `${kind} ${slug}`).toBe(s);
			expect(html(s, kind, slug)).toContain('<div class="post-inner thin">');
			expect(html(s, kind, slug)).not.toContain("one-column");
		}
		expect(bodyClassFor(s, "page", "about")).toBe(bodyClassFor(sample(), "page"));
	});

	const refused: Array<[string, unknown]> = [
		["pages that are not a list", { ...sample(), pages: { contact: contactOf() } }],
		["a page layout that is not an object", { ...sample(), pages: ["contact"] }],
		["a page with no slug", { ...sample(), pages: [{ ...contactOf(), slug: undefined }] }],
		["a slug that is a path", { ...sample(), pages: [{ ...contactOf(), slug: "../admin" }] }],
		["a slug with a space", { ...sample(), pages: [{ ...contactOf(), slug: "a b" }] }],
		[
			"a slug past 128 letters",
			{ ...sample(), pages: [{ ...contactOf(), slug: "a".repeat(129) }] },
		],
		["two pages of one slug", { ...sample(), pages: [contactOf(), contactOf()] }],
		[
			"a script in a page layout",
			{
				...sample(),
				pages: [{ ...contactOf(), parts: [{ html: "<script>x</script>" }, ...contactOf().parts] }],
			},
		],
		[
			"a page stylesheet on another host",
			{ ...sample(), pages: [{ ...contactOf(), styles: ["https://old-host.example/c.css"] }] },
		],
		[
			"a page layout with no content slot",
			{
				...sample(),
				pages: [
					{
						...contactOf(),
						parts: contactOf().parts.filter((p) => !("slot" in p) || p.slot !== "content"),
					},
				],
			},
		],
		[
			"a page body class that leaves its attribute",
			{ ...sample(), pages: [{ ...contactOf(), body: { class: 'x" onload="y' } }] },
		],
	];
	for (const [what, record] of refused) {
		it(`refuses ${what}`, () => {
			expect(wpShellProblem(record)).not.toBeNull();
		});
	}
});

/** A Gravity Forms form as Embark's writer cuts it: the plugin's markup, with holes for EmDash's form. */
function gfSkin(): WpShellForm {
	return {
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
			{ name: "input_4", label: "Size", type: "select", required: false },
			{ name: "input_5", label: "Colour", type: "radio", required: true, options: 2 },
			{ name: "input_3", label: "Comments?", type: "textarea", required: false },
		],
		parts: [
			'<div class="gform_wrapper" id="gform_wrapper_2">',
			{ s: "form" },
			'<ul class="gform_fields"><li class="gfield">',
			{ s: "label", class: "gfield_label" },
			'Your Name<span class="gfield_required">*</span>',
			{ s: "/label" },
			'<span class="name_first">',
			{ s: "control", field: 0 },
			{ s: "label", field: 0, option: 0 },
			"First",
			{ s: "/label" },
			"</span>",
			{ s: "error", field: 0 },
			'</li><li class="gfield">',
			{ s: "label", field: 1, class: "gfield_label" },
			"Your Email",
			{ s: "/label" },
			'<div class="ginput_container">',
			{ s: "control", field: 1, class: "large" },
			'</div><div class="gfield_description">We write rarely.</div></li><li class="gfield"><ul class="gfield_checkbox"><li>',
			{ s: "control", field: 2 },
			{ s: "label", field: 2, option: 0 },
			"Keep me up to date",
			{ s: "/label" },
			'</li></ul></li><li class="gfield">',
			{ s: "control", field: 3, class: "medium gfield_select" },
			'</li><li class="gfield">',
			{ s: "control", field: 4, option: 0 },
			{ s: "label", field: 4, option: 0 },
			"Red",
			{ s: "/label" },
			{ s: "control", field: 4, option: 1 },
			{ s: "label", field: 4, option: 1 },
			"Blue",
			{ s: "/label" },
			'</li><li class="gfield">',
			{ s: "control", field: 5, class: "textarea medium", rows: 10, cols: 50 },
			'</li></ul><div class="gform_footer">',
			{ s: "submit", tag: "input", class: "gform_button button" },
			"</div>",
			{ s: "/form" },
			"</div>",
		],
	};
}

/** The EmDash form the importer made of it, as the forms plugin's public definition gives it. */
function gfDefinition(): WpShellFormDefinition {
	return {
		pages: [
			{
				fields: [
					{ type: "text", name: "input_2_3", label: "Your Name: First", required: true },
					{
						type: "email",
						name: "input_1",
						label: "Your  Email",
						required: true,
						helpText: "We write rarely.",
					},
					{ type: "checkbox", name: "input_6", label: "Keep me up to date", required: false },
					{
						type: "select",
						name: "input_4",
						label: "Size",
						required: false,
						placeholder: "Pick one",
						options: [
							{ label: "S", value: "S" },
							{ label: "M & L", value: 'M"L' },
						],
					},
					{
						type: "radio",
						name: "input_5",
						label: "Colour",
						required: true,
						defaultValue: "blue",
						options: [
							{ label: "Red", value: "red" },
							{ label: "Blue", value: "blue" },
						],
					},
					{
						type: "textarea",
						name: "input_3",
						label: "Comments?",
						required: false,
						validation: { maxLength: 1000 },
					},
					{
						type: "hidden",
						name: "source",
						label: "Source",
						required: false,
						defaultValue: "wp&co",
					},
				],
			},
		],
		settings: { spamProtection: "honeypot", submitLabel: 'Get in "touch"!' },
	};
}

const SUBMIT = "/_emdash/api/plugins/emdash-forms/submit";

describe("wp-shell: a form in its plugin's markup, for the EmDash form imported from it", () => {
	it("matches the skin to the EmDash form whose fields are its own, in the skin's order", () => {
		const s = { ...sample(), forms: [gfSkin()] };
		expect(wpShellProblem(s)).toBeNull();
		const match = formSkin(s, gfDefinition());
		expect(match?.form).toBe(s.forms[0]);
		expect(match?.fields.map((f) => f.name)).toEqual([
			"input_2_3",
			"input_1",
			"input_6",
			"input_4",
			"input_5",
			"input_3",
		]);
		// a Jetpack skin names no fields: they are matched by label
		const byLabel = {
			...gfSkin(),
			plugin: "jetpack" as const,
			fields: gfSkin().fields.map(({ name: _name, ...f }) => f),
		};
		expect(formSkin({ ...sample(), forms: [byLabel] }, gfDefinition())?.form).toBe(byLabel);
	});

	it("draws in EmDash's own markup a form an admin has changed, or one the skin cannot hold", () => {
		const s = { ...sample(), forms: [gfSkin()] };
		const changed = (change: (d: WpShellFormDefinition) => void) => {
			const d = gfDefinition();
			change(d);
			return formSkin(s, d);
		};
		const fields = (d: WpShellFormDefinition) => d.pages[0]!.fields;
		for (const [what, change] of [
			["a label", (d) => void (fields(d)[0]!.label = "Given name")],
			["a field made required", (d) => void (fields(d)[2]!.required = true)],
			["a help text", (d) => void (fields(d)[1]!.helpText = "Or not.")],
			["a type", (d) => void (fields(d)[1]!.type = "text")],
			["a name", (d) => void (fields(d)[1]!.name = "email")],
			[
				"a choice added",
				(d) => void fields(d)[4]!.options!.push({ label: "Green", value: "green" }),
			],
			[
				"a field added",
				(d) =>
					void fields(d).push({ type: "text", name: "extra", label: "Extra", required: false }),
			],
			["a field taken away", (d) => void fields(d).splice(5, 1)],
			["a second page", (d) => void d.pages.push({ fields: [] })],
			["a condition", (d) => void (fields(d)[5]!.condition = { field: "input_6", equals: "1" })],
			[
				"a file field",
				(d) => void fields(d).push({ type: "file", name: "cv", label: "CV", required: false }),
			],
		] as Array<[string, (d: WpShellFormDefinition) => void]>)
			expect(changed(change), what).toBeNull();
		// and a record with no skins draws every form as EmDash's
		expect(formSkin(sample(), gfDefinition())).toBeNull();
	});

	it("draws the EmDash form in the skin: its element, action, names, validation, spam check and status line", () => {
		const def = gfDefinition();
		const match = formSkin({ ...sample(), forms: [gfSkin()] }, def)!;
		const html = renderWpShellForm(match, def, { formId: "01FORM", submitUrl: SUBMIT });
		expect(html).toBe(
			[
				'<div class="gform_wrapper" id="gform_wrapper_2">',
				`<form method="POST" action="${SUBMIT}" data-form-id="01FORM" data-ec-form data-ec-skin="gravityforms"><div data-page="0" style="display:contents">`,
				'<ul class="gform_fields"><li class="gfield">',
				'<label class="gfield_label">Your Name<span class="gfield_required">*</span></label>',
				'<span class="name_first"><input type="text" id="01FORM-input_2_3" name="input_2_3" required><label for="01FORM-input_2_3">First</label></span>',
				// the field's error line where the skin puts it, not after its control
				'<output class="ec-form-error" data-error-for="input_2_3" aria-live="polite"></output>',
				'</li><li class="gfield"><label for="01FORM-input_1" class="gfield_label">Your Email</label>',
				'<div class="ginput_container"><input type="email" class="large" id="01FORM-input_1" name="input_1" required>',
				'<output class="ec-form-error" data-error-for="input_1" aria-live="polite"></output>',
				'</div><div class="gfield_description">We write rarely.</div></li><li class="gfield"><ul class="gfield_checkbox"><li>',
				'<input type="checkbox" id="01FORM-input_6" name="input_6" value="1">',
				'<output class="ec-form-error" data-error-for="input_6" aria-live="polite"></output>',
				'<label for="01FORM-input_6">Keep me up to date</label></li></ul></li><li class="gfield">',
				'<select class="medium gfield_select" id="01FORM-input_4" name="input_4"><option value="" disabled selected>Pick one</option><option value="S">S</option><option value="M&quot;L">M &amp; L</option></select>',
				'<output class="ec-form-error" data-error-for="input_4" aria-live="polite"></output>',
				'</li><li class="gfield">',
				'<input type="radio" id="01FORM-input_5-0" name="input_5" value="red" required><label for="01FORM-input_5-0">Red</label>',
				// one error line for the choices, after the last
				'<input type="radio" id="01FORM-input_5-1" name="input_5" value="blue" checked required>',
				'<output class="ec-form-error" data-error-for="input_5" aria-live="polite"></output>',
				'<label for="01FORM-input_5-1">Blue</label>',
				'</li><li class="gfield">',
				'<textarea class="textarea medium" id="01FORM-input_3" name="input_3" maxlength="1000" rows="10" cols="50"></textarea>',
				'<output class="ec-form-error" data-error-for="input_3" aria-live="polite"></output>',
				'</li></ul><div class="gform_footer"><input type="submit" class="gform_button button ec-form-submit" value="Get in &quot;touch&quot;!"></div>',
				"</div>",
				// the honeypot, the form's hidden fields, its id and its status line, as FormEmbed draws them
				'<div class="ec-form-field" style="position:absolute;left:-9999px;" aria-hidden="true"><label for="01FORM-_hp">Leave blank</label><input type="text" id="01FORM-_hp" name="_hp" tabindex="-1" autocomplete="off"></div>',
				'<input type="hidden" name="source" value="wp&amp;co">',
				'<input type="hidden" name="formId" value="01FORM"><div class="ec-form-status" data-form-status aria-live="polite"></div></form>',
				"</div>",
			].join(""),
		);
	});

	it("draws Turnstile where the form asks for it, a button where the skin has one, and escapes every value", () => {
		const def = gfDefinition();
		def.settings = { spamProtection: "turnstile", submitLabel: "<b>Send</b>" };
		def._turnstileSiteKey = 'key"1';
		fieldsOf(def)[5]!.defaultValue = "</textarea><script>x</script>";
		fieldsOf(def)[1]!.placeholder = 'you@"example".org';
		const skin = gfSkin();
		skin.parts = skin.parts.map((x) =>
			typeof x !== "string" && x.s === "submit"
				? { s: "submit", tag: "button", class: "gform_button" }
				: x,
		);
		const html = renderWpShellForm(formSkin({ ...sample(), forms: [skin] }, def)!, def, {
			formId: 'F"1',
			submitUrl: SUBMIT,
		});
		expect(html).toContain(
			'<div class="ec-form-turnstile" data-ec-turnstile data-sitekey="key&quot;1"></div>',
		);
		expect(html).not.toContain('name="_hp"');
		expect(html).toContain(
			'<button type="submit" class="gform_button ec-form-submit">&lt;b&gt;Send&lt;/b&gt;</button>',
		);
		expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;</textarea>");
		expect(html).toContain('placeholder="you@&quot;example&quot;.org"');
		expect(html).toContain('data-form-id="F&quot;1"');
		expect(html).not.toMatch(/<script|<b>/);
		// Turnstile with no site key draws no widget, as FormEmbed does not
		def._turnstileSiteKey = null;
		expect(
			renderWpShellForm(formSkin({ ...sample(), forms: [skin] }, def)!, def, {
				formId: "F",
				submitUrl: SUBMIT,
			}),
		).not.toContain("turnstile");
	});

	/** The sample record with the skin changed. */
	const skinned = (change: (f: Record<string, unknown>) => void): unknown => {
		const f = gfSkin() as unknown as Record<string, unknown>;
		change(f);
		return { ...sample(), forms: [f] };
	};
	const parts = (f: Record<string, unknown>) => f.parts as unknown[];
	const refused: Array<[string, unknown]> = [
		["forms that are not a list", { ...sample(), forms: gfSkin() }],
		["a form of another plugin", skinned((f) => void (f.plugin = "wpforms"))],
		["a form with no fields", skinned((f) => void (f.fields = []))],
		[
			"a field name that is not one",
			skinned((f) => void ((f.fields as Array<Record<string, unknown>>)[0]!.name = 'a" b')),
		],
		[
			"a field type the skin does not draw",
			skinned((f) => void ((f.fields as Array<Record<string, unknown>>)[0]!.type = "file")),
		],
		[
			"a field whose required is not a yes or no",
			skinned((f) => void ((f.fields as Array<Record<string, unknown>>)[0]!.required = "yes")),
		],
		[
			"a control in the captured markup",
			skinned((f) => void parts(f).splice(2, 0, '<input name="x">')),
		],
		[
			"a form element in the captured markup",
			skinned((f) => void parts(f).splice(2, 0, '<form action="https://x.example/">')),
		],
		[
			"an event handler in the captured markup",
			skinned((f) => void parts(f).splice(2, 0, '<div onclick="x">')),
		],
		[
			"a hole inside a tag",
			skinned((f) => void parts(f).splice(2, 0, '<div class="', { s: "error", field: 0 }, '">')),
		],
		[
			"a hole of a kind the layout does not fill",
			skinned((f) => void parts(f).splice(2, 0, { s: "script" })),
		],
		[
			"a control that names no field",
			skinned((f) => void parts(f).splice(2, 0, { s: "control", field: 6 })),
		],
		[
			"an error line that names no field",
			skinned((f) => void parts(f).splice(2, 0, { s: "error" })),
		],
		[
			"a choice past the field's",
			skinned((f) => void parts(f).splice(2, 0, { s: "control", field: 4, option: 2 })),
		],
		[
			"a class that is not tokens",
			skinned(
				(f) => void parts(f).splice(2, 0, { s: "control", field: 0, class: 'x" onclick="y' }),
			),
		],
		[
			"a text box past a thousand rows",
			skinned((f) => void parts(f).splice(2, 0, { s: "control", field: 5, rows: 5000 })),
		],
		[
			"a second submit control",
			skinned((f) => void parts(f).splice(2, 0, { s: "submit", tag: "input" })),
		],
		[
			"a submit control that is another element",
			skinned((f) => void parts(f).splice(2, 0, { s: "submit", tag: "a" })),
		],
		[
			"no form element",
			skinned(
				(f) =>
					void (f.parts = parts(f).filter(
						(x) => typeof x === "string" || (x as { s: string }).s !== "form",
					)),
			),
		],
		["a label left open", skinned((f) => void parts(f).splice(2, 0, { s: "label" }))],
		[
			"a label closed that was never opened",
			skinned((f) => void parts(f).splice(2, 0, { s: "/label" })),
		],
	];
	for (const [what, record] of refused) {
		it(`refuses ${what}`, () => {
			expect(wpShellProblem(record)).not.toBeNull();
		});
	}
});

const fieldsOf = (d: WpShellFormDefinition) => d.pages[0]!.fields;

/** The listing, laid out in lanes as a theme's masonry, each item's height estimated by its image alone. */
function lanesOf(columns = 2): WpShellListing {
	return {
		...listingOf(),
		count: 5,
		lanes: {
			columns,
			from: 1,
			min: 992,
			estimate: {
				titleChars: 16,
				titleLine: 0,
				textChars: 29,
				textLine: 0,
				paragraph: 0,
				base: 100,
				thumbWidth: 200,
			},
		},
	};
}
const own = (n: number) => `/_emdash/api/media/file/0${n}.png`;
const LANE_POSTS: WpShellPost[] = [
	{ title: "Lead", url: "/posts/lead", text: "a" },
	{ title: "Tall", url: "/posts/tall", text: "a", image: own(1), imageRatio: 1 },
	{ title: "B", url: "/posts/b", text: "a" },
	{ title: "C", url: "/posts/c", text: "a" },
	{ title: "D", url: "/posts/d", text: "a" },
	{ title: "Past the count", url: "/posts/e", text: "a" },
];

describe("wp-shell: a listing's masonry drawn in lanes, with no script", () => {
	it("draws the first items, then each post in the lane an estimate of its height says is the shortest", () => {
		const html = renderListing(lanesOf(), LANE_POSTS);
		const items = (lane: string) =>
			Array.from(lane.matchAll(/item-title"><a href="\/posts\/(\w+)"/g), (m) => m[1]);
		const [lead, ...lanes] = html.split('<div class="wp-shell-lane">');
		expect(items(lead!)).toEqual(["lead"]);
		// Tall (100 + 200) goes left; B, C and D (100 each) go right until it passes Tall's 300
		expect(lanes.map(items)).toEqual([["tall"], ["b", "c", "d"]]);
		// each item says its place, which orders the items where the lanes do not hold
		expect(Array.from(html.matchAll(/wp-shell-at-(\d)/g), (m) => Number(m[1]))).toEqual([
			0, 1, 2, 3, 4,
		]);
		expect(html).toContain('<div class="item-wrap col-md-12 wp-shell-at-0">');
		expect(html).toContain('<div class="item-wrap col-md-3 col-sm-6 wp-shell-at-4">');
		// the leftmost of equal lanes; and with no lanes, the items in order and no place classes
		expect(
			renderListing(lanesOf(3), LANE_POSTS)
				.split('<div class="wp-shell-lane">')
				.slice(1)
				.map(items),
		).toEqual([["tall"], ["b", "d"], ["c"]]);
		expect(renderListing(listingOf(), LANE_POSTS)).not.toMatch(/wp-shell-(lane|at-)/);
	});

	it("estimates an item's height from its title, text, paragraphs and image, as the record says", () => {
		const listing = {
			...listingOf(),
			excerpt: { words: 55, more: " […]", paragraphs: true as const },
			lanes: {
				columns: 4,
				from: 1,
				min: 992,
				estimate: {
					titleChars: 16,
					titleLine: 24,
					textChars: 29,
					textLine: 24,
					paragraph: 20,
					base: 78,
					thumbWidth: 263,
				},
			},
		};
		const post = (over: Partial<WpShellPost>): WpShellPost => ({
			title: "A".repeat(20),
			url: "/posts/a",
			excerpt: `${"b".repeat(40)}\n\n${"c".repeat(10)}`,
			...over,
		});
		// 78 + 2 title lines + 2 text lines (50 letters) + one paragraph break
		expect(laneHeight(listing, post({}))).toBe(78 + 48 + 48 + 20);
		// its own image at its own height over width, and one of unknown size at 3:4
		expect(laneHeight(listing, post({ image: own(2), imageRatio: 0.5 }))).toBe(
			78 + 48 + 48 + 20 + 131.5,
		);
		expect(laneHeight(listing, post({ image: own(2) }))).toBe(78 + 48 + 48 + 20 + 263 * 0.75);
		// an image from elsewhere is not drawn, so it adds nothing
		expect(
			laneHeight(listing, post({ image: "https://elsewhere.example/p.png", imageRatio: 1 })),
		).toBe(78 + 48 + 48 + 20);
		expect(laneHeight(listingOf(), post({}))).toBe(0);
		expect(imageRatio({ width: 300, height: 228 })).toBe(0.76);
		for (const bad of [null, "x", {}, { width: 0, height: 10 }, { width: "300", height: 200 }])
			expect(imageRatio(bad)).toBeNull();
	});

	const lanesWith = (patch: Record<string, unknown>) =>
		withListing({ ...lanesOf(), lanes: { ...lanesOf().lanes!, ...patch } } as WpShellListing);
	const estimateWith = (patch: Record<string, unknown>) =>
		lanesWith({ estimate: { ...lanesOf().lanes!.estimate, ...patch } });
	it("accepts the lanes the writer produces", () => {
		expect(wpShellProblem(withListing(lanesOf()))).toBeNull();
	});
	const refused: Array<[string, WpShell]> = [
		["lanes that are not an object", withListing({ ...lanesOf(), lanes: "4" } as never)],
		["no lanes", lanesWith({ columns: 0 })],
		["more lanes than a row holds", lanesWith({ columns: 13 })],
		["lanes that start past the items", lanesWith({ from: 6 })],
		["a width that is not one", lanesWith({ min: -1 })],
		["an estimate that is not a number", estimateWith({ base: "78" })],
		["an estimate past any page", estimateWith({ thumbWidth: 1e9 })],
		["an estimate that is not finite", estimateWith({ titleLine: Number.NaN })],
		["an estimate short of a field", lanesWith({ estimate: { titleChars: 16 } })],
	];
	for (const [what, record] of refused) {
		it(`refuses ${what}`, () => {
			expect(wpShellProblem(record)).not.toBeNull();
		});
	}
});

describe("wp-shell: a video embedded from a link in classic content", () => {
	it("is WordPress's player for a YouTube or Vimeo link that carries no block markup", () => {
		expect(
			classicVideoEmbed({ _type: "embed", url: "https://vimeo.com/100000001", provider: "vimeo" }),
		).toEqual({
			src: "https://player.vimeo.com/video/100000001",
			title: "Vimeo video",
			allow: "autoplay; fullscreen; picture-in-picture",
		});
		for (const url of [
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			"https://youtu.be/dQw4w9WgXcQ",
		])
			expect(classicVideoEmbed({ _type: "embed", url })?.src).toBe(
				"https://www.youtube.com/embed/dQw4w9WgXcQ",
			);
	});

	it("is EmDash's own embed for anything else", () => {
		for (const node of [
			// a Gutenberg embed block carries its markup
			{ url: "https://vimeo.com/1", html: '<figure class="wp-block-embed"></figure>' },
			{ url: "https://example.org/v.mp4", provider: "video" },
			{ url: "https://vimeo.com/1", provider: "audio" },
			{ url: "https://twitter.com/x/status/1" },
			{ url: "javascript:alert(1)//vimeo.com/1" },
			{ url: 7 },
			null,
		])
			expect(classicVideoEmbed(node), JSON.stringify(node)).toBeNull();
	});
});

/** A Franz Josef single post's layout, as Embark's writer cuts it from a donor post. */
function postOf(): WpShellPostLayout {
	return {
		body: { class: "wp-singular post-template-default single single-post single-format-standard" },
		styles: ["/_emdash/api/media/file/wp-shell/post1.css"],
		parts: [
			{ html: '<div class="breadcrumbs"><span><a href="/">Home</a></span> &gt; ' },
			{ slot: "trailTerm" },
			{ slot: "titleText" },
			{ html: '</div><div class="post hentry">' },
			{ slot: "title", tag: "h1", class: "entry-title" },
			{ slot: "postMeta", meta: 0 },
			{ slot: "featured" },
			{ slot: "content", tag: "div", class: "entry-content clearfix" },
			{ slot: "authorBio" },
			{ slot: "adjacent" },
			{ slot: "comments", tag: "div", class: "comment-respond", id: "respond" },
			{ html: "</div>" },
		],
		date: "F j, Y",
		utcOffset: -480,
		meta: [
			[
				'<ul class="entry-meta"><li class="date"><a href="',
				{ s: "href" },
				'">',
				{ s: "date" },
				'</a></li><li class="byline">By <span class="author"><a rel="author">',
				{ s: "author" },
				"</a></span>",
				{ s: "categories" },
				"</li>",
				{ s: "comments" },
				{ s: "tags" },
				"</ul>",
			],
		],
		terms: {
			category: {
				item: [' under <span class="terms">', { s: "terms" }, "</span>"],
				term: ['<a class="term term-category" href="', { s: "href" }, '">', { s: "label" }, "</a>"],
				sep: ", ",
			},
			tag: {
				item: ['<li class="entry-tags"><i class="fa fa-tags"></i>', { s: "terms" }, "</li>"],
				term: ['<a href="', { s: "href" }, '">', { s: "label" }, "</a>"],
				sep: ", ",
			},
		},
		comments: {
			item: [
				'<li class="comments-count"><a href="',
				{ s: "href" },
				'#respond">',
				{ s: "count" },
				"</a></li>",
			],
			zero: "Leave a reply",
		},
		featured: {
			item: [
				'<div class="featured-image"><img alt="',
				{ s: "alt" },
				'" src="',
				{ s: "src" },
				'" width="850" height="450" class="wp-post-image wp-shell-crop"></div>',
			],
			minWidth: 850,
		},
		trailTerm: [
			'<span><a href="',
			{ s: "href" },
			'" class="taxonomy category">',
			{ s: "label" },
			"</a></span> &gt; ",
		],
		author: {
			item: [
				'<div class="entry-author"><div class="author-avatar"><a rel="author">',
				{ s: "avatar" },
				'</a></div><div class="author-bio"><h3>',
				{ s: "name" },
				"</h3>",
				{ s: "bio" },
				"</div></div>",
			],
			avatar: ['<img class="avatar" width="125" height="125" src="', { s: "src" }, '" alt="">'],
		},
		adjacent: {
			item: [
				'<div class="prev-next-posts"><div class="prev-post">',
				{ s: "prev" },
				'</div><div class="next-post">',
				{ s: "next" },
				"</div></div>",
			],
			prev: [
				"<h3>Previous</h3><h4>",
				{ s: "adjTitle" },
				'</h4><a href="',
				{ s: "adjHref" },
				'" class="post-link">\u00a0</a>',
			],
			next: [
				"<h3>Next</h3><h4>",
				{ s: "adjTitle" },
				'</h4><a href="',
				{ s: "adjHref" },
				'" class="post-link">\u00a0</a>',
			],
		},
		share: [
			'<div class="sharedaddy"><ul><li><a href="',
			{ s: "share-x" },
			'" class="share-twitter">X</a></li><li><a href="',
			{ s: "share-email" },
			'" class="share-email">Email</a></li></ul></div>',
		],
	};
}
const withPost = (post: WpShellPostLayout = postOf()): WpShell => ({ ...sample(), post });
const aPost = (o: Partial<WpShellPostFill> = {}): WpShellPostFill => ({
	url: "/posts/a-post",
	absoluteUrl: "https://example.org/posts/a-post",
	title: "A Post",
	date: new Date("2014-05-01T05:57:19Z"),
	author: "Pat Author",
	categories: [
		{ label: "Research", slug: "research" },
		{ label: "advocacy", slug: "advocacy" },
	],
	tags: [{ label: "debt", slug: "debt" }],
	comments: 0,
	image: "/_emdash/api/media/file/01ABC.png",
	imageWidth: 1237,
	alt: "",
	...o,
});
const drawPost = (fill: WpShellPostFill | null, shell: WpShell = withPost()) =>
	composeWpShell(shell, {
		menuItems: () => null,
		currentPath: "/posts/a-post",
		kind: "post",
		title: "A Post",
		post: fill,
	})
		.map((p) =>
			"html" in p
				? p.html
				: "title" in p
					? "[TITLE]"
					: "comments" in p
						? `[COMMENTS ${p.comments.id}]`
						: `[CONTENT]${p.end ?? ""}`,
		)
		.join("");

describe("wp-shell: a single post in its own layout", () => {
	it("accepts the post layout, and draws a post from it", () => {
		const shell = withPost();
		expect(wpShellProblem(shell)).toBeNull();
		expect(layoutFor(shell, "post")).toBe(shell.post);
		expect(bodyClassFor(withPost(), "post")).toBe(
			"wp-singular post-template-default single single-post single-format-standard",
		);
		const html = drawPost(aPost());
		// the trail names the first category by name, WordPress's order
		expect(html).toContain(
			'<span><a href="/category/advocacy" class="taxonomy category">advocacy</a></span> &gt; A Post',
		);
		// the date in the site's zone: 05:57 UTC on May 1 is April 30 at UTC-8
		expect(html).toContain('<li class="date"><a href="/posts/a-post">April 30, 2014</a></li>');
		expect(html).toContain(
			'By <span class="author"><a rel="author">Pat Author</a></span> under <span class="terms"><a class="term term-category" href="/category/advocacy">advocacy</a>, <a class="term term-category" href="/category/research">Research</a></span></li>',
		);
		expect(html).toContain(
			'<li class="comments-count"><a href="/posts/a-post#respond">Leave a reply</a></li>',
		);
		expect(html).toContain(
			'<li class="entry-tags"><i class="fa fa-tags"></i><a href="/tag/debt">debt</a></li>',
		);
		expect(html).toContain(
			'<img alt="" src="/_emdash/api/media/file/01ABC.png" width="850" height="450"',
		);
		expect(html).toContain(
			'[CONTENT]<div class="sharedaddy"><ul><li><a href="https://x.com/intent/tweet?url=https%3A%2F%2Fexample.org%2Fposts%2Fa-post&amp;text=A%20Post" class="share-twitter">X</a></li><li><a href="mailto:?subject=A%20Post&amp;body=https%3A%2F%2Fexample.org%2Fposts%2Fa-post" class="share-email">Email</a></li></ul></div>',
		);
		expect(html).toContain("[COMMENTS respond]");
	});

	it("escapes every value it fills, and links only to the post, its terms and the share pages", () => {
		const html = drawPost(
			aPost({
				title: 'A "quoted" <b>post</b>',
				author: "<b>Pat</b> & co",
				url: "javascript:alert(1)",
				categories: [{ label: 'News "&" <i>views</i>', slug: "news/../x y" }],
				tags: [],
			}),
		);
		expect(html).toContain("&lt;b&gt;Pat&lt;/b&gt; &amp; co");
		expect(html).not.toContain("<b>Pat</b>");
		expect(html).toContain('<a href="#">');
		expect(html).not.toContain("javascript:");
		expect(html).toContain(
			'href="/category/news%2F..%2Fx%20y">News "&amp;" &lt;i&gt;views&lt;/i&gt;</a>',
		);
		expect(html).toContain("text=A%20%22quoted%22%20%3Cb%3Epost%3C%2Fb%3E");
		// no tags: the tags item is not drawn at all
		expect(html).not.toContain("entry-tags");
		expect(html).not.toMatch(/<script|onclick|onerror/);
	});

	it("draws the featured image only for the site's own file at the theme's width", () => {
		expect(featuredDrawn(postOf(), aPost())).toBe(true);
		expect(featuredDrawn(postOf(), aPost({ imageWidth: 738 }))).toBe(false);
		expect(featuredDrawn(postOf(), aPost({ imageWidth: null }))).toBe(false);
		expect(featuredDrawn(postOf(), aPost({ image: "https://elsewhere.example/a.png" }))).toBe(
			false,
		);
		expect(featuredDrawn(postOf(), aPost({ image: null }))).toBe(false);
		expect(
			featuredDrawn(
				{ ...postOf(), featured: { ...postOf().featured!, minWidth: 0 } },
				aPost({ imageWidth: null }),
			),
		).toBe(true);
		expect(drawPost(aPost({ imageWidth: 738 }))).not.toContain("featured-image");
	});

	it("draws the comment count only for a count whose phrase the record knows", () => {
		expect(drawPost(aPost({ comments: 3 }))).not.toContain("comments-count");
		expect(drawPost(aPost({ comments: null }))).not.toContain("comments-count");
		const many = withPost({
			...postOf(),
			comments: { ...postOf().comments!, many: "%d comments" },
		});
		expect(drawPost(aPost({ comments: 3 }), many)).toContain(
			'<a href="/posts/a-post#respond">3 comments</a>',
		);
		expect(drawPost(aPost({ comments: 1 }), many)).not.toContain("comments-count");
	});

	it("skips a meta whose date or author the post does not have, and a trail term for a post with no category", () => {
		expect(drawPost(aPost({ date: null }))).not.toContain("entry-meta");
		expect(drawPost(aPost({ author: null }))).not.toContain("entry-meta");
		const none = drawPost(aPost({ categories: [] }));
		expect(none).toContain('<a rel="author">Pat Author</a></span></li>');
		expect(none).toContain("&gt; A Post");
		expect(none).not.toContain("taxonomy category");
		// no address to share: no share links
		expect(drawPost(aPost({ absoluteUrl: null }))).toContain('[CONTENT]<div class="entry-author">');
	});

	it("draws the site time zone's day, by name", () => {
		const zoned = withPost({ ...postOf(), utcOffset: undefined, timeZone: "America/Los_Angeles" });
		expect(drawPost(aPost({ date: new Date("2014-05-01T05:57:19Z") }), zoned)).toContain(
			"April 30, 2014",
		);
		expect(drawPost(aPost({ date: new Date("2014-05-01T08:00:00Z") }), zoned)).toContain(
			"May 1, 2014",
		);
	});

	it("draws a post in the record's own layout when the record has no post layout", () => {
		const s = sample();
		expect(layoutFor(s, "post")).toBe(s);
		const html = composeWpShell(s, {
			menuItems: () => null,
			currentPath: "/posts/a",
			kind: "post",
			post: aPost(),
		});
		expect(html.some((p) => "comments" in p)).toBe(false);
		expect(bodyClassFor(s, "post")).toContain("single single-post");
	});

	it("reads a post's values from its entry as EmDash hydrates it", () => {
		const fill = wpShellPostFill(
			{
				title: "A Post",
				publishedAt: new Date("2014-05-01T05:57:19Z"),
				bylines: [{ byline: { displayName: "Pat Author" }, sortOrder: 0 }],
				terms: {
					category: [{ label: "Policy", slug: "policy", id: "x" }],
					tag: [{ label: "debt", slug: "debt" }, { label: 3 }],
				},
				featured_image: {
					id: "01ABC",
					provider: "local",
					width: 1237,
					height: 906,
					alt: "A photo",
					meta: { storageKey: "01ABC.png" },
				},
			},
			{ url: "/posts/a-post", origin: "https://example.org", comments: 2 },
		);
		expect(fill).toEqual({
			url: "/posts/a-post",
			absoluteUrl: "https://example.org/posts/a-post",
			title: "A Post",
			date: new Date("2014-05-01T05:57:19Z"),
			author: "Pat Author",
			categories: [{ label: "Policy", slug: "policy" }],
			tags: [{ label: "debt", slug: "debt" }],
			comments: 2,
			image: "/_emdash/api/media/file/01ABC.png",
			imageWidth: 1237,
			alt: "A photo",
			bio: null,
			avatar: null,
			prev: null,
			next: null,
		});
		// the byline's bio and its avatar (a file of the site's), and the posts beside it as the route read them
		const byline = wpShellPostFill(
			{
				bylines: [
					{ byline: { displayName: "Pat", bio: "Pat writes.", avatarStorageKey: "01AV.jpg" } },
				],
			},
			{
				url: "/posts/b",
				origin: "https://example.org",
				comments: null,
				prev: { title: "Older", url: "/posts/older" },
				next: null,
			},
		);
		expect(byline).toMatchObject({
			author: "Pat",
			bio: "Pat writes.",
			avatar: "/_emdash/api/media/file/01AV.jpg",
			prev: { title: "Older", url: "/posts/older" },
			next: null,
		});
		expect(
			wpShellPostFill(
				{ bylines: [{ byline: { displayName: "Pat", avatarStorageKey: "../../x" } }] },
				{ url: "/posts/b", origin: "https://example.org", comments: null },
			).avatar,
		).toBeNull();
		expect(
			wpShellPostFill({}, { url: "/posts/x", origin: "https://example.org", comments: null }),
		).toMatchObject({ author: null, date: null, image: null, categories: [], tags: [] });
	});

	it("draws the author's bio, their avatar where it is one of the site's files, and the posts beside it", () => {
		const html = drawPost(
			aPost({
				bio: "First <line>.\n\nSecond & last.",
				avatar: "/_emdash/api/media/file/01AV.jpg",
				prev: { title: "Older <one>", url: "/posts/older" },
				next: null,
			}),
		);
		expect(html).toContain(
			'<div class="entry-author"><div class="author-avatar"><a rel="author"><img class="avatar" width="125" height="125" src="/_emdash/api/media/file/01AV.jpg" alt=""></a></div><div class="author-bio"><h3>Pat Author</h3><p>First &lt;line&gt;.</p><p>Second &amp; last.</p></div></div>',
		);
		expect(html).toContain(
			'<div class="prev-next-posts"><div class="prev-post"><h3>Previous</h3><h4>Older &lt;one&gt;</h4><a href="/posts/older" class="post-link">\u00a0</a></div><div class="next-post"></div></div>',
		);
		// an avatar from elsewhere is not drawn; no bio, no paragraphs; no post beside it, no block
		const bare = drawPost(aPost({ avatar: "https://gravatar.example/a.jpg", bio: null }));
		expect(bare).toContain(
			'<a rel="author"></a></div><div class="author-bio"><h3>Pat Author</h3></div>',
		);
		expect(bare).not.toContain("prev-next-posts");
		expect(drawPost(aPost({ author: null }))).not.toContain("entry-author");
		expect(drawPost(aPost({ next: { title: "N", url: "javascript:alert(1)" } }))).toContain(
			'<h4>N</h4><a href="#"',
		);
	});

	/** The post layout with one field replaced. */
	const posted = (
		change: Partial<WpShellPostLayout> | ((p: WpShellPostLayout) => WpShellPostLayout),
	) => withPost(typeof change === "function" ? change(postOf()) : { ...postOf(), ...change });
	it.each<[string, WpShell]>([
		[
			"a post slot in the record's own layout",
			{ ...withPost(), parts: [...sample().parts, { slot: "postMeta", meta: 0 }] },
		],
		[
			"a post slot in the home layout",
			{ ...withPost(), home: { ...homeOf(), parts: [...homeOf().parts, { slot: "featured" }] } },
		],
		[
			"a comments slot in a page layout",
			{
				...withPost(),
				pages: [
					{ ...contactOf(), parts: [...contactOf().parts, { slot: "comments", tag: "div" }] },
				],
			},
		],
		[
			"a meta slot that names no meta",
			posted((p) => ({ ...p, parts: [...p.parts, { slot: "postMeta", meta: 3 }] })),
		],
		["a featured slot with no featured template", posted((p) => ({ ...p, featured: undefined }))],
		[
			"two comments slots",
			posted((p) => ({ ...p, parts: [...p.parts, { slot: "comments", tag: "div" }] })),
		],
		[
			"a comments element this layout does not draw",
			posted((p) => ({
				...p,
				parts: p.parts.map((x) =>
					"slot" in x && x.slot === "comments" ? { ...x, tag: "form" as "div" } : x,
				),
			})),
		],
		[
			"an href hole outside its attribute",
			posted({ trailTerm: ["<span>", { s: "href" }, "</span>"] }),
		],
		[
			"a src hole outside its attribute",
			posted({ featured: { item: ['<img alt="', { s: "src" }, '">'], minWidth: 0 } }),
		],
		[
			"a text hole inside an attribute",
			posted({ meta: [['<a title="', { s: "author" }, '">x</a>']] }),
		],
		[
			"a markup hole inside an attribute",
			posted({ meta: [['<a title="', { s: "categories" }, '">x</a>']] }),
		],
		["a hole a meta does not draw", posted({ meta: [["<p>", { s: "src" }, "</p>"]] })],
		[
			"a script in a meta template",
			posted({ meta: [["<script>alert(1)</script>", { s: "date" }]] }),
		],
		[
			"a handler in a term template",
			posted((p) => ({
				...p,
				terms: {
					tag: {
						...p.terms!.tag!,
						term: ['<a onclick="x()" href="', { s: "href" }, '">', { s: "label" }, "</a>"],
					},
				},
			})),
		],
		[
			"a javascript: link in the share links",
			posted({ share: ['<a href="javascript:alert(1)">x</a>'] }),
		],
		[
			"a phrase with markup",
			posted((p) => ({ ...p, comments: { ...p.comments!, zero: "<b>Leave</b>" } })),
		],
		[
			"a phrase with two counts",
			posted((p) => ({ ...p, comments: { ...p.comments!, many: "%d of %d" } })),
		],
		[
			"a separator with markup",
			posted((p) => ({ ...p, terms: { tag: { ...p.terms!.tag!, sep: "<br>" } } })),
		],
		[
			"a width that is not one",
			posted((p) => ({ ...p, featured: { ...p.featured!, minWidth: -1 } })),
		],
		["a date format that is not one", posted({ date: "F j, Y <b>" })],
		[
			"an image from elsewhere in a template",
			posted({ meta: [['<img src="https://tracker.example/p.gif">', { s: "date" }]] }),
		],
		[
			"an avatar src hole outside its attribute",
			posted((p) => ({ ...p, author: { ...p.author!, avatar: ["<img>", { s: "src" }] } })),
		],
		[
			"an adjacent side's link hole outside its attribute",
			posted((p) => ({
				...p,
				adjacent: { ...p.adjacent!, next: ["<h4>", { s: "adjHref" }, "</h4>"] },
			})),
		],
		["an author slot with no author template", posted((p) => ({ ...p, author: undefined }))],
	])("refuses the record whole for %s", (_, record) => {
		expect(wpShellProblem(record)).not.toBeNull();
	});
});
