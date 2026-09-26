import { describe, expect, it, vi } from "vitest";

import {
	bodyClassFor,
	composeWpShell,
	formatWpDate,
	isCurrent,
	layoutFor,
	listingExcerpt,
	ownImagePath,
	parseWpShell,
	parseWpShellCached,
	plainText,
	renderListing,
	renderMenu,
	safeHref,
	wpShellDocumentTitle,
	wpShellProblem,
	wpShellRoute,
	type WpShell,
	type WpShellListing,
	type WpShellMenu,
	type WpShellPost,
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
		// the toggles, the listing and its thumbnail are among them
		const all = JSON.stringify(writerRecords);
		for (const shape of [
			'<details class=\\"wp-shell-toggle',
			'href=\\"#wp-shell-menu-0\\"',
			'"listings"',
			'"thumb"',
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
