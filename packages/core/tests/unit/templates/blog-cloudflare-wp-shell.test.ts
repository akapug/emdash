import { describe, expect, it, vi } from "vitest";

import {
	bodyClassFor,
	classicVideoEmbed,
	composeWpShell,
	drawsTitle,
	featuredDrawn,
	formatWpDate,
	formatWpTime,
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
	renderArchiveNav,
	renderArchivePosts,
	renderArchives,
	renderIndexNav,
	renderIndexPosts,
	renderListing,
	renderMenu,
	renderWpShellComments,
	renderWpShellForm,
	renderWpShellSubscribe,
	safeHref,
	stylesFor,
	WP_SHELL_FEATURES,
	WP_SHELL_SUBSCRIBE_MESSAGES,
	wpShellDateSite,
	wpShellDocumentTitle,
	wpShellIndexRoute,
	wpShellPostFill,
	wpShellProblem,
	wpShellRoute,
	type WpShell,
	type WpShellComment,
	type WpShellCommentArea,
	type WpShellForm,
	type WpShellFormDefinition,
	type WpShellListing,
	type WpShellMenu,
	type WpShellPageLayout,
	type WpShellPost,
	type WpShellPostFill,
	type WpShellPostLayout,
	type WpShellSubscribe,
} from "../../../../../templates/blog-cloudflare/src/utils/wp-shell";
import declaredWpShellFeatures from "../../../../../templates/blog-cloudflare/src/utils/wp-shell-features.json";
import { SUBSCRIBE_STATUSES } from "../../../../plugins/subscriptions/src/subscriptions";
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

describe("wp-shell declared reader features", () => {
	it("exports the checked-in declaration beside the reader, sorted and without duplicates", () => {
		expect(WP_SHELL_FEATURES).toEqual(declaredWpShellFeatures);
		expect(WP_SHELL_FEATURES).toEqual([...new Set(WP_SHELL_FEATURES)].toSorted());
	});

	it("declares every nested record capability the writer guard cannot learn from top-level keys", () => {
		for (const name of [
			"record.menus[].current",
			"record.listings[].lanes",
			"record.archives[].as",
			"record.titles.hidden",
			"record.titles.shown",
			"record.dates.front",
			"record.dates.plain",
			"record.dates.timeZone",
			"record.dates.utcOffset",
			"record.dates.title",
			"record.dates.title.year",
			"record.dates.title.month",
			"record.dates.title.day",
			"record.post.commentArea.parts",
			"record.post.commentArea.heading",
			"record.post.commentArea.list",
			"record.post.commentArea.respond",
			"record.post.commentArea.fields",
			"record.subscribe[].generic",
			"record.slot.subtitle",
			"record.index",
			"record.index.body",
			"record.index.listing",
			"record.index.parts",
			"record.index.styles",
		])
			expect(WP_SHELL_FEATURES, name).toContain(name);
	});
});

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
 * posts, and for a Hello Elementor page that hides its own title on a site
 * whose other pages print theirs (packages/control-plane/test/wp-shell.test.ts),
 * and for its Kleo fixtures: a post in its own layout, a page whose title is
 * hidden, a post with no title band and related posts, and a page that prints
 * its title where the site hides every other page's (test/wp-shell-kleo.test.ts),
 * and for a footer whose Archives widget and Jetpack sign-up are slots, each
 * dumped with WPSHELL_DUMP=1. A tripwire that refused them would put every
 * migrated site back in the template's own design.
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
			'{"slot":"archives","archives":0}',
			'{"slot":"subscribe","subscribe":0}',
			'"dates"',
			'{"s":"phrase"}',
			'{"s":"adjTitle"}',
			'"many":"%d Comments"',
			// Kleo's: the hidden title, jQuery Sticky's wrapper, a textless toggle's line, both collapses
			// the toggle opens, the search link, the sticky links' ids and the bare comment count.
			'{"slot":"title","tag":"h1","class":"wp-shell-untitled"}',
			'<div class=\\"sticky-wrapper\\">',
			"wp-shell-noline",
			'id=\\"wp-shell-menu-0-1\\"',
			'class=\\"search-trigger wp-shell-control\\" href=\\"/search\\"',
			'id=\\"older-nav\\"',
			'"many":"%d"',
			// A post's comment area: Kleo's count heading and form in its boxes, Franz Josef's reply block alone
			// with EmDash's form, Twenty Twenty's comments in the walker's div style with their time.
			'"commentArea"',
			'"zero":"%d Comments"',
			'{"s":"field","field":"authorName"}',
			'{"s":"submit","tag":"input","id":"submit","class":"submit","label":"Post comment"}',
			'"parts":[{"s":"list"},{"s":"respond"}]',
			'{"s":"emdash"}',
			'"replies":[{"s":"items"}]',
			'"time":"g:i a"',
			'"many":"%d replies on \u201c%t\u201d"',
			// Elementor's: the pages of its full-width template in one layout, each page's own rules and
			// body classes, Pro's menu toggle as the summary of the details that holds its dropdown.
			'"also":["privacy"]',
			'"pageOwn"',
			'"body":"page-id-21 elementor-page-21"',
			// the home in a layout of its own: the body classes that name it alone
			'{"slug":"home","body":"page-id-2 elementor-page-2"}',
			'<details class=\\"wp-shell-toggle wp-shell-opens-0\\"><summary class=\\"elementor-menu-toggle wp-shell-control\\">',
			'<span class=\\"wp-shell-label\\">Menu Toggle</span></summary>',
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

describe("wp-shell: a template's layout its pages share, and each page's own", () => {
	const html = (s: WpShell, kind: "home" | "page" | "post", slug: string | null) =>
		composeWpShell(s, { menuItems: () => null, currentPath: "/pages/x", kind, slug })
			.flatMap((p) => ("html" in p ? [p.html] : []))
			.join("");
	const OWN = "/_emdash/api/media/file/wp-shell/own21.css";
	const wide = (): WpShell => ({
		...sample(),
		home: homeOf(),
		pages: [{ ...contactOf(), slug: "privacy", also: ["terms", "events"] }],
		pageOwn: [
			{ slug: "about", styles: [OWN], body: "page-id-21 elementor-page-21" },
			{ slug: "terms", styles: ["/_emdash/api/media/file/wp-shell/own7.css"] },
			{ slug: "home", body: "page-id-2" },
		],
	});

	it("draws every page `also` names in the page layout, its title the layout's, and every other page in the record's", () => {
		const s = wide();
		expect(wpShellProblem(s)).toBeNull();
		for (const slug of ["privacy", "terms", "events"]) {
			expect(layoutFor(s, "page", slug), slug).toBe(s.pages![0]);
			expect(html(s, "page", slug)).toContain('<main class="one-column">');
			expect(drawsTitle(s, "page", slug)).toBe(true);
		}
		for (const [kind, slug] of [
			["page", "about"],
			["post", "terms"],
		] as const) {
			expect(layoutFor(s, kind, slug), `${kind} ${slug}`).toBe(s);
			expect(html(s, kind, slug)).not.toContain("one-column");
		}
	});

	it("adds a page's own stylesheets after its layout's, and its own body classes, for a page and the home of its slug alone", () => {
		const s = wide();
		expect(stylesFor(s, "page", "about")).toEqual([...s.styles, OWN]);
		expect(bodyClassFor(s, "page", "about")).toBe(
			`${bodyClassFor(sample(), "page")} page-id-21 elementor-page-21`,
		);
		// in a layout it shares with other pages
		expect(stylesFor(s, "page", "terms")).toEqual([
			"/_emdash/api/media/file/wp-shell/contact1.css",
			"/_emdash/api/media/file/wp-shell/own7.css",
		]);
		expect(bodyClassFor(s, "page", "terms")).toBe(
			"page-template-template-full-width page page-id-9",
		);
		// the home, by its page's slug, in its own layout
		expect(stylesFor(s, "home", "home")).toEqual(homeOf().styles);
		expect(bodyClassFor(s, "home", "home")).toBe(`${homeOf().body.class} page-id-2`);
		// a class the layout has already is not drawn twice
		const twice: WpShell = { ...s, pageOwn: [{ slug: "about", body: "wp-singular page-id-21" }] };
		expect(bodyClassFor(twice, "page", "about")).toBe(
			`${bodyClassFor(sample(), "page")} page-id-21`,
		);
		// a post or an archive of that slug, and a page of no slug, draw none of it
		for (const [kind, slug] of [
			["post", "about"],
			["archive", "about"],
			["page", null],
			["home", null],
		] as const) {
			expect(stylesFor(s, kind, slug), `${kind} ${slug}`).toEqual(layoutFor(s, kind, slug).styles);
			expect(bodyClassFor(s, kind, slug)).toBe(
				bodyClassFor({ ...s, pageOwn: undefined }, kind, slug),
			);
		}
	});

	it("draws a record without them as before", () => {
		for (const s of [sample(), { ...sample(), home: homeOf(), pages: [contactOf()] }]) {
			for (const [kind, slug] of [
				["home", "home"],
				["page", "contact"],
				["page", "about"],
				["post", "x"],
				["archive", null],
			] as const) {
				expect(stylesFor(s, kind, slug)).toEqual(layoutFor(s, kind, slug).styles);
			}
		}
	});

	const refused: Array<[string, unknown]> = [
		[
			"other pages that are not a list",
			{ ...sample(), pages: [{ ...contactOf(), also: "terms" }] },
		],
		["another page with no slug", { ...sample(), pages: [{ ...contactOf(), also: ["a b"] }] }],
		[
			"a page drawn in two layouts",
			{
				...sample(),
				pages: [
					{ ...contactOf(), also: ["terms"] },
					{ ...contactOf(), slug: "terms" },
				],
			},
		],
		[
			"a page named twice in one layout",
			{ ...sample(), pages: [{ ...contactOf(), also: ["terms", "terms"] }] },
		],
		[
			"a layout that names itself again",
			{ ...sample(), pages: [{ ...contactOf(), also: ["contact"] }] },
		],
		["pages' own that are not a list", { ...sample(), pageOwn: { about: { styles: [OWN] } } }],
		["an own with no slug", { ...sample(), pageOwn: [{ styles: [OWN] }] }],
		[
			"two owns of one page",
			{
				...sample(),
				pageOwn: [
					{ slug: "about", styles: [OWN] },
					{ slug: "about", body: "x" },
				],
			},
		],
		["an own that carries nothing", { ...sample(), pageOwn: [{ slug: "about" }] }],
		[
			"an own stylesheet on another host",
			{ ...sample(), pageOwn: [{ slug: "about", styles: ["https://old-host.example/c.css"] }] },
		],
		[
			"an own stylesheet that is not a stylesheet",
			{
				...sample(),
				pageOwn: [{ slug: "about", styles: ["/_emdash/api/media/file/wp-shell/x.js"] }],
			},
		],
		[
			"more own stylesheets than a page has",
			{ ...sample(), pageOwn: [{ slug: "about", styles: Array.from({ length: 9 }).fill(OWN) }] },
		],
		[
			"own body classes that leave their attribute",
			{ ...sample(), pageOwn: [{ slug: "about", body: 'x" onload="y' }] },
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

/**
 * A post's comment area as Embark's writer cuts it from a Kleo donor: the
 * count heading in the theme's words, a comment in its markup for one, and
 * the reply form in its markup for each box.
 */
function areaOf(): WpShellCommentArea {
	return {
		parts: [
			{ s: "heading" },
			'<div id="comments-list">',
			{ s: "list" },
			'</div><div id="respond-wrap">',
			{ s: "respond" },
			"</div>",
		],
		heading: {
			item: ['<div class="hr-title hr-long"><abbr>', { s: "count" }, "</abbr></div>"],
			zero: "%d Comments",
		},
		list: {
			item: ["<ol>", { s: "items" }, "</ol>"],
			comment: [
				'<li id="comment-',
				{ s: "id" },
				'" class="',
				{ s: "cls" },
				'"><div class="comment-meta"><span class="comment-author">',
				{ s: "author" },
				'</span> <a href="#comment-',
				{ s: "id" },
				'"><time>',
				{ s: "date" },
				" at ",
				{ s: "time" },
				'</time></a></div><div class="comment-body">',
				{ s: "text" },
				"</div>",
				{ s: "replies" },
				"</li>",
			],
			replies: ['<ol class="children">', { s: "items" }, "</ol>"],
			classes: "comment clearfix",
			date: "F j, Y",
			time: "g:i a",
		},
		respond: [
			'<div id="respond" class="comment-respond"><h3 id="reply-title" class="comment-reply-title">Leave a reply</h3>',
			{ s: "form", id: "commentform", class: "comment-form" },
			'<p class="comment-notes">Your email address will not be published.</p>',
			{ s: "field", field: "body" },
			'<div class="row">',
			{ s: "field", field: "authorName" },
			{ s: "field", field: "authorEmail" },
			'</div><p class="form-submit">',
			{ s: "submit", tag: "input", id: "submit", class: "submit", label: "Post comment" },
			"</p>",
			{ s: "/form" },
			"</div>",
		],
		fields: {
			body: [
				'<p class="comment-form-comment">',
				{ s: "label", for: "comment" },
				"Comment",
				{ s: "/label" },
				{ s: "control", id: "comment", class: "form-control", rows: 8, cols: 45 },
				"</p>",
			],
			authorName: [
				'<p class="comment-form-author col-sm-4">',
				{ s: "label", for: "author" },
				"Name",
				{ s: "/label" },
				' <span class="required">*</span>',
				{ s: "control", id: "author", class: "form-control", size: 30 },
				"</p>",
			],
			authorEmail: [
				'<p class="comment-form-email col-sm-4">',
				{ s: "label", for: "email" },
				"Email",
				{ s: "/label" },
				' <span class="required">*</span>',
				{ s: "control", id: "email", class: "form-control", size: 30 },
				"</p>",
			],
		},
	};
}
const withArea = (area: WpShellCommentArea = areaOf()) =>
	withPost({ ...postOf(), commentArea: area });
const ENDPOINT = "/_emdash/api/comments/posts/01POST";
const aComment = (o: Partial<WpShellComment> = {}): WpShellComment => ({
	id: "01JCOMMENT0",
	authorName: "Ann Reader",
	body: "The first words.",
	createdAt: "2014-05-01T17:05:00.000Z",
	...o,
});
const drawComments = (
	o: Partial<Parameters<typeof renderWpShellComments>[1]> = {},
	post: WpShellPostLayout = withArea().post!,
) =>
	renderWpShellComments(post, { endpoint: ENDPOINT, total: 0, items: [], title: "A Post", ...o })
		.map((p) => ("html" in p ? p.html : `[EMDASH ${p.emdash}]`))
		.join("");

describe("wp-shell: a post's comments in the theme's comment area", () => {
	it("accepts a post layout with a comment area", () => {
		expect(wpShellProblem(withArea())).toBeNull();
		expect(JSON.stringify(writerRecords)).toContain('"commentArea"');
	});

	it("draws the count heading in the theme's words where the record knows them, else EmDash's, and none at zero unless known", () => {
		expect(drawComments({ total: 0 })).toContain(
			'<div class="hr-title hr-long"><abbr>0 Comments</abbr></div>',
		);
		expect(drawComments({ total: 1, items: [aComment()] })).toContain("<abbr>1 Comment</abbr>");
		expect(drawComments({ total: 3, items: [aComment()] })).toContain("<abbr>3 Comments</abbr>");
		const many = areaOf();
		many.heading = { ...many.heading!, zero: undefined, many: "%d replies on “%t”" };
		const post = withArea(many).post!;
		expect(drawComments({ total: 0 }, post)).not.toContain("hr-title");
		expect(
			drawComments({ total: 2, items: [aComment()], title: "Tom & <b>$&</b>" }, post),
		).toContain("<abbr>2 replies on “Tom &amp; &lt;b&gt;$&amp;&lt;/b&gt;”</abbr>");
	});

	it("draws the comments in the theme's markup for one, each with WordPress's classes, its replies in the theme's reply list", () => {
		const html = drawComments({
			total: 3,
			items: [
				aComment({
					replies: [
						aComment({ id: "01JREPLY", authorName: "Bo", createdAt: "2014-05-02T04:30:00.000Z" }),
					],
				}),
				aComment({ id: "01JSECOND", authorName: "Cy" }),
			],
		});
		expect(html).toContain(
			'<ol><li id="comment-01JCOMMENT0" class="comment clearfix even thread-even depth-1 parent"><div class="comment-meta"><span class="comment-author">Ann Reader</span> <a href="#comment-01JCOMMENT0"><time>May 1, 2014 at 9:05 am</time></a></div><div class="comment-body"><p>The first words.</p></div><ol class="children"><li id="comment-01JREPLY" class="comment clearfix odd alt depth-2">',
		);
		// the reply's day and time in the site's zone: 04:30 UTC on May 2 is 8:30 pm on May 1 at UTC-8
		expect(html).toContain(
			'<span class="comment-author">Bo</span> <a href="#comment-01JREPLY"><time>May 1, 2014 at 8:30 pm</time></a>',
		);
		expect(html).toContain(
			'<li id="comment-01JSECOND" class="comment clearfix even thread-odd thread-alt depth-1">',
		);
		expect(html).toMatch(
			/<\/li><\/ol><\/li><li id="comment-01JSECOND"[\s\S]*<\/li><\/ol><\/div><div id="respond-wrap">/,
		);
	});

	it("writes a comment's author and words escaped, its paragraphs and lines as WordPress prints them, its links as EmDash's Comments does", () => {
		const html = drawComments({
			total: 1,
			items: [
				aComment({
					authorName: '<img src=x onerror="1">',
					body: 'One <b>two</b> "q"\nnext https://example.org/a?b=1&c=2 end\n\n\nSecond para',
				}),
			],
		});
		expect(html).toContain('<span class="comment-author">&lt;img src=x onerror="1"&gt;</span>');
		expect(html).toContain(
			'<div class="comment-body"><p>One &lt;b&gt;two&lt;/b&gt; "q"<br>next <a href="https://example.org/a?b=1&amp;c=2" rel="nofollow ugc noopener" target="_blank">https://example.org/a?b=1&amp;c=2</a> end</p><p>Second para</p></div>',
		);
		expect(html).not.toContain("<img");
		// Its id too, in the id and the link to it: EmDash's ids are its own, but the page never trusts them to be tokens.
		const odd = drawComments({ total: 1, items: [aComment({ id: `01J"><i x='y'>` })] });
		expect(odd).toContain(`<li id="comment-01J&quot;&gt;&lt;i x=&#39;y&#39;&gt;" class="comment`);
		expect(odd).toContain(`<a href="#comment-01J&quot;&gt;&lt;i x=&#39;y&#39;&gt;">`);
		expect(odd).not.toContain("<i ");
	});

	it("draws no list at no comments, and EmDash's own list where the record has no comment of the theme's", () => {
		expect(drawComments({ total: 0 })).not.toMatch(/<ol>|\[EMDASH list\]/);
		const bare = { ...areaOf(), list: undefined };
		expect(drawComments({ total: 1, items: [aComment()] }, withArea(bare).post!)).toContain(
			'<div id="comments-list">[EMDASH list]</div>',
		);
	});

	it("draws EmDash's comment form in the theme's markup: CommentForm's element attributes, boxes, limits, honeypot and status line", () => {
		const html = drawComments();
		expect(html).toContain(
			'<form id="commentform" class="comment-form" data-ec-comment-form data-endpoint="/_emdash/api/comments/posts/01POST" data-user-name="" data-user-email=""><p class="comment-notes">',
		);
		expect(html).toContain(
			'<p class="comment-form-comment"><label for="comment">Comment</label><textarea id="comment" class="form-control" name="body" required maxlength="5000" rows="8" cols="45"></textarea></p>',
		);
		expect(html).toContain(
			'<input type="text" id="author" class="form-control" name="authorName" required maxlength="100" size="30">',
		);
		expect(html).toContain(
			'<input type="email" id="email" class="form-control" name="authorEmail" required size="30">',
		);
		expect(html).toContain(
			'<p class="form-submit"><input type="submit" id="submit" class="submit ec-comment-form-submit" value="Post comment"></p><div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;"><label>Don\'t fill this out<input type="text" name="website_url" tabindex="-1" autocomplete="off"></label></div><div class="ec-comment-form-status" role="status" aria-live="polite"></div></form>',
		);
	});

	it("draws a signed-in user's name and email in place of the theme's boxes for them, as CommentForm does", () => {
		const html = drawComments({ user: { name: 'Ed "E" <b>', email: "ed@example.org" } });
		expect(html).toContain(
			'data-user-name="Ed &quot;E&quot; &lt;b&gt;" data-user-email="ed@example.org"',
		);
		expect(html).toContain(
			'<div class="row"><div class="ec-comment-user-info"><span class="ec-comment-user-name">Ed "E" &lt;b&gt;</span><span class="ec-comment-user-email">ed@example.org</span></div></div>',
		);
		expect(html).not.toMatch(/name="author(Name|Email)"/);
		expect(html).toContain('name="body"');
	});

	it("draws EmDash's own form where the record has none of the theme's, and a theme's button with its words", () => {
		const jetpack = areaOf();
		jetpack.respond = [
			'<div id="respond"><h3 id="reply-title">Leave a Reply</h3>',
			{ s: "emdash" },
			"</div>",
		];
		delete jetpack.fields;
		expect(wpShellProblem(withArea(jetpack))).toBeNull();
		expect(drawComments({}, withArea(jetpack).post!)).toContain(
			'<h3 id="reply-title">Leave a Reply</h3>[EMDASH form]</div>',
		);
		const button = areaOf();
		button.respond = button.respond.map((x) =>
			typeof x !== "string" && x.s === "submit"
				? { s: "submit", tag: "button", class: "btn", label: "Send it" }
				: x,
		);
		expect(drawComments({}, withArea(button).post!)).toContain(
			'<button type="submit" class="btn ec-comment-form-submit">Send it</button>',
		);
	});

	it("draws a box with the theme's size and hint, EmDash's own size where it has none, and a label outside the boxes", () => {
		const a = areaOf();
		a.fields!.body = [
			'<p class="comment-form-comment">',
			{ s: "control", id: "comment", placeholder: 'Say "hi" & more' },
			"</p>",
		];
		a.respond = a.respond.flatMap((x) =>
			typeof x !== "string" && x.s === "/form"
				? [{ s: "label", for: "comment", class: "note" }, "Your words", { s: "/label" }, x]
				: [x],
		);
		expect(wpShellProblem(withArea(a))).toBeNull();
		const html = drawComments({}, withArea(a).post!);
		expect(html).toContain(
			'<textarea id="comment" name="body" required maxlength="5000" rows="4" placeholder="Say &quot;hi&quot; &amp; more"></textarea>',
		);
		expect(html).toContain('<label for="comment" class="note">Your words</label>');
	});

	it("prints no date or time for a comment of no known moment", () => {
		const html = drawComments({ total: 1, items: [aComment({ createdAt: "not a date" })] });
		expect(html).toContain("<time> at </time>");
	});

	it("prints a comment's time as PHP's date() does, in the site's zone", () => {
		const at = new Date("2014-05-01T17:05:00Z");
		expect(formatWpTime(at, "g:i a", { utcOffset: -480 })).toBe("9:05 am");
		expect(formatWpTime(at, "g:i A", { timeZone: "America/Denver" })).toBe("11:05 AM");
		expect(formatWpTime(at, "H:i")).toBe("17:05");
		expect(formatWpTime(new Date("2014-05-01T00:07:00Z"), "g:i a h G")).toBe("12:07 am 12 0");
		// a zone this runtime does not know: the site's offset from UTC
		expect(formatWpTime(at, "H:i", { timeZone: "Nowhere/Atlantis", utcOffset: 60 })).toBe("18:05");
	});

	const area = (change: (a: WpShellCommentArea) => void) => {
		const a = areaOf();
		change(a);
		return withArea(a);
	};
	it.each<[string, WpShell]>([
		["a hole of another template's in the area's parts", area((a) => a.parts.push({ s: "count" }))],
		["a second reply block", area((a) => a.parts.push({ s: "respond" }))],
		["a heading hole with no heading", area((a) => delete a.heading)],
		["a heading phrase with markup", area((a) => (a.heading!.zero = "<b>%d</b>"))],
		["a heading phrase with the title twice", area((a) => (a.heading!.zero = "%t %t"))],
		[
			"a class hole outside its attribute",
			area(
				(a) =>
					(a.list!.comment = [
						"<li>",
						{ s: "cls" },
						{ s: "author" },
						{ s: "text" },
						{ s: "replies" },
						"</li>",
					]),
			),
		],
		[
			"an id hole outside an id or a link to the page",
			area(
				(a) =>
					(a.list!.comment = [
						'<li class="',
						{ s: "cls" },
						'" title="',
						{ s: "id" },
						'">',
						{ s: "author" },
						{ s: "text" },
						{ s: "replies" },
						"</li>",
					]),
			),
		],
		[
			"a comment with no words",
			area(
				(a) =>
					(a.list!.comment = a.list!.comment.filter(
						(x) => typeof x === "string" || x.s !== "text",
					)),
			),
		],
		["a date hole with no date format", area((a) => delete a.list!.date)],
		["a time format that is not one", area((a) => (a.list!.time = "g:i <b>"))],
		["list classes that are not tokens", area((a) => (a.list!.classes = 'comment" onclick="x'))],
		["a list with no items hole", area((a) => (a.list!.item = ["<ol></ol>"]))],
		[
			"a box id that claims to be EmDash's",
			area((a) => (a.fields!.body = [{ s: "control", id: "emdash-toolbar" }])),
		],
		[
			"a label for an id that is not a token",
			area(
				(a) =>
					(a.fields!.body = [
						{ s: "label", for: 'x" onclick="y' },
						{ s: "/label" },
						{ s: "control" },
					]),
			),
		],
		["a label left open", area((a) => (a.fields!.body = [{ s: "label" }, { s: "control" }]))],
		["a box of no size", area((a) => (a.fields!.body = [{ s: "control", rows: 0 }]))],
		[
			"a placeholder with markup",
			area((a) => (a.fields!.body = [{ s: "control", placeholder: "<b>x</b>" }])),
		],
		[
			"a submit label with markup",
			area(
				(a) =>
					(a.respond = a.respond.map((x) =>
						typeof x !== "string" && x.s === "submit" ? { ...x, label: "<i>Go</i>" } : x,
					)),
			),
		],
		[
			"a submit control of another tag",
			area(
				(a) =>
					(a.respond = a.respond.map((x) =>
						typeof x !== "string" && x.s === "submit"
							? ({ ...x, tag: "a" } as unknown as typeof x)
							: x,
					)),
			),
		],
		[
			"a box outside the form element",
			area((a) => (a.respond = [{ s: "field", field: "body" }, ...a.respond])),
		],
		[
			"a form's only box for a field moved outside the form element",
			area(
				(a) =>
					(a.respond = [
						{ s: "field", field: "body" },
						...a.respond.filter(
							(x) => typeof x === "string" || x.s !== "field" || x.field !== "body",
						),
					]),
			),
		],
		[
			"a box of no EmDash field's beside the three",
			area(
				(a) =>
					(a.respond = a.respond.flatMap((x) =>
						typeof x !== "string" && x.s === "submit"
							? [{ s: "field", field: "website" } as unknown as typeof x, x]
							: [x],
					)),
			),
		],
		[
			"a hole inside an attribute's value",
			area((a) => (a.heading!.item = ['<abbr title="', { s: "count" }, '"></abbr>'])),
		],
		[
			"a field of no EmDash field's",
			area(
				(a) =>
					(a.respond = a.respond.map((x) =>
						typeof x !== "string" && x.s === "field" && x.field === "body"
							? ({ s: "field", field: "website" } as unknown as typeof x)
							: x,
					)),
			),
		],
		[
			"a form with a box missing",
			area(
				(a) =>
					(a.respond = a.respond.filter(
						(x) => typeof x === "string" || x.s !== "field" || x.field !== "authorEmail",
					)),
			),
		],
		["EmDash's own form beside the theme's", area((a) => a.respond.push({ s: "emdash" }))],
		[
			"no form of the theme's and no EmDash form",
			area((a) => {
				a.respond = ["<div></div>"];
				delete a.fields;
			}),
		],
		[
			"a script in a template",
			area((a) => (a.list!.item = ["<ol><script>x()</script>", { s: "items" }, "</ol>"])),
		],
		[
			"a form element in a template",
			area((a) => (a.fields!.body = ["<form>", { s: "control" }, "</form>"])),
		],
		[
			"an event handler in a template",
			area(
				(a) =>
					(a.parts = [
						'<div onclick="x()">',
						{ s: "heading" },
						{ s: "list" },
						{ s: "respond" },
						"</div>",
					]),
			),
		],
		[
			"a hole inside a tag",
			area((a) => (a.heading!.item = ["<abbr ", { s: "count" }, "></abbr>"])),
		],
		["a second list", area((a) => a.parts.push({ s: "list" }))],
		["a heading with no phrase hole", area((a) => (a.heading!.item = ["<abbr></abbr>"]))],
		["a reply list with no items hole", area((a) => (a.list!.replies = ["<ol></ol>"]))],
		["a hole of the form's in a comment", area((a) => a.list!.comment.push({ s: "control" }))],
		[
			"a comment with no author",
			area(
				(a) =>
					(a.list!.comment = a.list!.comment.filter(
						(x) => typeof x === "string" || x.s !== "author",
					)),
			),
		],
		[
			"a comment with no replies hole",
			area(
				(a) =>
					(a.list!.comment = a.list!.comment.filter(
						(x) => typeof x === "string" || x.s !== "replies",
					)),
			),
		],
		["a time hole with no time format", area((a) => delete a.list!.time)],
		[
			"a box's class that is not tokens",
			area((a) => (a.fields!.body = [{ s: "control", class: 'x" onclick="y' }])),
		],
		["a box with no control", area((a) => (a.fields!.body = ["<p></p>"]))],
		[
			"a field of no EmDash field's among the fields",
			area((a) => ((a.fields as Record<string, unknown>).website = [{ s: "control" }])),
		],
		[
			"a submit control with no words",
			area(
				(a) =>
					(a.respond = a.respond.map((x) =>
						typeof x !== "string" && x.s === "submit" ? { ...x, label: "" } : x,
					)),
			),
		],
		[
			"an area larger than a shell",
			area((a) => a.respond.unshift(`<p>${"x".repeat(1_000_001)}</p>`)),
		],
	])("refuses the record whole for %s", (_, record) => {
		expect(wpShellProblem(record)).not.toBeNull();
	});
});

describe("wp-shell: which pages print their title, page by page", () => {
	const drawn = (s: WpShell, kind: "home" | "page" | "post", slug: string | null) =>
		composeWpShell(s, { menuItems: () => null, currentPath: "/", kind, slug }).some(
			(p) => "title" in p,
		);
	const hidden = (): WpShell => ({ ...sample(), titles: { hidden: ["app", "home"] } });

	it("draws no title for a page `hidden` names, the home by its page's slug, and every other page's", () => {
		const s = hidden();
		expect(wpShellProblem(s)).toBeNull();
		expect(drawn(s, "page", "app")).toBe(false);
		expect(drawn(s, "home", "home")).toBe(false);
		expect(drawn(s, "page", "home")).toBe(false);
		for (const [kind, slug] of [
			["page", "about"],
			["page", null],
			["home", "welcome"],
			["home", null],
			["post", "app"],
		] as const) {
			expect(drawn(s, kind, slug), `${kind} ${slug}`).toBe(true);
			expect(drawsTitle(s, kind, slug)).toBe(true);
		}
		// the title is left out, and nothing else: the markup around it and the content, as drawn with it
		const read = (pieces: ReturnType<typeof composeWpShell>) =>
			pieces
				.map((p) =>
					"html" in p ? p.html : "title" in p ? "[title]" : "content" in p ? "[content]" : "",
				)
				.join("");
		const all = read(
			composeWpShell(sample(), {
				menuItems: () => null,
				currentPath: "/",
				kind: "page",
				slug: "app",
			}),
		);
		expect(all).toContain("[title]");
		expect(
			read(
				composeWpShell(s, { menuItems: () => null, currentPath: "/", kind: "page", slug: "app" }),
			),
		).toBe(all.replace("[title]", ""));
	});

	it("draws the title only for the pages `shown` names: every other page, and a post in the record's layout, draws none", () => {
		const s: WpShell = { ...sample(), titles: { shown: ["donate"] } };
		expect(wpShellProblem(s)).toBeNull();
		expect(drawn(s, "page", "donate")).toBe(true);
		for (const [kind, slug] of [
			["page", "about"],
			["page", null],
			["home", "home"],
			["home", null],
			["post", "donate"],
		] as const)
			expect(drawn(s, kind, slug), `${kind} ${slug}`).toBe(false);
	});

	it("leaves a page in a layout of its own, the home's own and the post layout to their own title", () => {
		for (const titles of [{ hidden: ["contact", "home", "a-post"] }, { shown: [] }]) {
			const s: WpShell = { ...withPost(), home: homeOf(), pages: [contactOf()], titles };
			expect(wpShellProblem(s)).toBeNull();
			expect(drawn(s, "page", "contact")).toBe(true);
			expect(drawn(s, "home", "home")).toBe(true);
			expect(drawn(s, "post", "a-post")).toBe(true);
		}
	});

	it("draws every page's title for a record without titles, as before", () => {
		for (const [kind, slug] of [
			["page", "app"],
			["home", "home"],
			["post", "app"],
		] as const)
			expect(drawn(sample(), kind, slug)).toBe(true);
	});

	it("refuses titles that name no pages", () => {
		for (const titles of [
			null,
			[],
			{},
			{ hidden: "app" },
			{ hidden: ["app"], shown: [] },
			{ drawn: ["app"] },
			{ hidden: ["../app"] },
			{ shown: ["app", "app"] },
			{ hidden: [7] },
			{ hidden: Array.from({ length: 1001 }, (_, i) => `p${i}`) },
		])
			expect(wpShellProblem({ ...sample(), titles }), JSON.stringify(titles).slice(0, 40)).toBe(
				"the titles name no pages",
			);
		expect(
			wpShellProblem({
				...sample(),
				titles: { hidden: Array.from({ length: 1000 }, (_, i) => `p${i}`) },
			}),
		).toBeNull();
	});

	it("is what Embark's writer names: a page's own choice on a site that prints its titles, and pages that print theirs where the site hides them", () => {
		const titled = writerRecords.filter((r) => "titles" in r) as unknown as WpShell[];
		expect(titled.map((r) => Object.keys(r.titles!))).toEqual([["hidden"], ["shown"]]);
		for (const r of titled) {
			expect(wpShellProblem(r)).toBeNull();
			// the record's own layout draws the title, and the page named keeps its own choice
			expect(r.parts.filter((p) => "slot" in p && p.slot === "title")).toEqual([
				{ slot: "title", tag: "h1" },
			]);
		}
		const [hid, shown] = titled;
		expect(drawn(hid!, "page", "app")).toBe(false);
		expect(drawn(hid!, "home", "home")).toBe(false);
		expect(drawn(hid!, "page", "about")).toBe(true);
		expect(drawn(shown!, "page", "donate")).toBe(true);
		expect(drawn(shown!, "page", "history")).toBe(false);
	});
});

// --- the footer's controls: WordPress's Archives widget and Jetpack's sign-up ------------

/** A footer as Embark's writer cuts it: WordPress's Archives widget's list box and Jetpack's sign-up as slots. */
function withFooterControls(): WpShell {
	const s = sample();
	s.parts.splice(
		-1,
		1,
		{
			html: '</div></article></main><footer id="site-footer"><div id="archives-2" class="widget_archive"><h4 class="item-title">Past posts</h4><span class="screen-reader-text">Past posts</span>',
		},
		{ slot: "archives", archives: 0 },
		{
			html: '</div><div id="blog_subscription-3" class="widget_blog_subscription"><h4 class="item-title">Follow by email</h4>',
		},
		{ slot: "subscribe", subscribe: 0 },
		{ html: "</div></footer>" },
	);
	s.archives = [
		{
			as: "dropdown",
			type: "monthly",
			count: true,
			id: "archives-dropdown-2",
			label: "Select Month",
		},
	];
	s.dates = {
		front: "/",
		timeZone: "America/Los_Angeles",
		title: { month: "Monthly Archive: %s", year: "Yearly Archive: %s" },
	};
	s.subscribe = [subscribeSkin()];
	return s;
}

function subscribeSkin(): WpShellSubscribe {
	return {
		plugin: "jetpack",
		parts: [
			'<div class="wp-block-jetpack-subscriptions__container">',
			{ s: "form", id: "subscribe-blog-blog_subscription-3" },
			{ s: "fields" },
			{ s: "/form" },
			{ s: "count" },
			"</div>",
		],
		fields: [
			'<div id="subscribe-text"><p>Enter your address to follow this site.</p></div><p id="subscribe-email">',
			{ s: "label", for: "subscribe-field-blog_subscription-3", class: "screen-reader-text" },
			"Email Address",
			{ s: "/label" },
			{ s: "control", id: "subscribe-field-blog_subscription-3", placeholder: "Email Address" },
			'</p><p id="subscribe-submit">',
			{ s: "submit", tag: "button", class: "wp-block-button__link", label: "Subscribe now" },
			"</p>",
		],
		count: {
			item: ['<div class="wp-block-jetpack-subscriptions__subscount">', { s: "phrase" }, "</div>"],
			one: "Join %s other subscriber",
			many: "Join %s other subscribers",
		},
	};
}

const SUBSCRIBE = {
	action: "/_emdash/api/plugins/emdash-subscriptions/subscribe",
	source: "/about/",
};

describe("the tripwire reads the footer's controls", () => {
	it("accepts an Archives widget, the site's date archives and a sign-up", () => {
		expect(wpShellProblem(withFooterControls())).toBeNull();
	});

	const refused: Array<[string, (s: WpShell) => void]> = [
		[
			"an archives slot naming no widget",
			(s) => void s.parts.push({ slot: "archives", archives: 1 }),
		],
		[
			"a subscribe slot naming no sign-up",
			(s) => void s.parts.push({ slot: "subscribe", subscribe: 2 }),
		],
		[
			"a widget that is neither a list box nor a list",
			(s) => void ((s.archives![0] as { as: string }).as = "select"),
		],
		["a widget's id that leaves its attribute", (s) => void (s.archives![0]!.id = 'x" onfocus="y')],
		[
			"a widget's first line past 200 letters",
			(s) => void (s.archives![0]!.label = "x".repeat(201)),
		],
		["a front that is not a path", (s) => void (s.dates!.front = "https://evil.example/")],
		["a front that climbs", (s) => void (s.dates!.front = "/../")],
		["a heading with markup", (s) => void (s.dates!.title!.month = "<b>%s</b>")],
		[
			"a heading with no place for the name",
			(s) => void (s.dates!.title!.month = "Monthly Archive"),
		],
		["a time zone that is not one", (s) => void (s.dates!.timeZone = "UTC; x")],
		[
			"a sign-up of another plugin",
			(s) => void ((s.subscribe![0] as { plugin: string }).plugin = "mailchimp"),
		],
		[
			"a sign-up with no form element",
			(s) =>
				void (s.subscribe![0]!.parts = s.subscribe![0]!.parts.filter(
					(x) => typeof x === "string" || x.s !== "form",
				)),
		],
		[
			"a sign-up whose fields are outside its form",
			(s) =>
				void (s.subscribe![0]!.parts = [
					"<div>",
					{ s: "form" },
					{ s: "/form" },
					{ s: "fields" },
					{ s: "count" },
					"</div>",
				]),
		],
		["a sign-up with two email boxes", (s) => void s.subscribe![0]!.fields.push({ s: "control" })],
		[
			"a hole inside a tag",
			// the one email box, moved into an attribute's value
			(s) =>
				void s.subscribe![0]!.fields.splice(
					4,
					1,
					'<span title="',
					s.subscribe![0]!.fields[4]!,
					'"></span>',
				),
		],
		[
			"a submit control's words past 200 letters",
			(s) =>
				void (s.subscribe![0]!.fields[6] = { s: "submit", tag: "button", label: "x".repeat(201) }),
		],
		[
			"a box's id that leaves its attribute",
			(s) => void (s.subscribe![0]!.fields[4] = { s: "control", id: 'x" autofocus onfocus="y' }),
		],
		[
			"a count phrase with two places",
			(s) => void (s.subscribe![0]!.count!.many = "Join %s of %s"),
		],
		["a count line drawn twice", (s) => void s.subscribe![0]!.parts.push({ s: "count" })],
		[
			"a form element in the sign-up's markup",
			(s) => void s.subscribe![0]!.fields.push('<form action="https://evil.example/"></form>'),
		],
		[
			"an input in the sign-up's markup",
			(s) => void s.subscribe![0]!.fields.push('<input name="email">'),
		],
		[
			"a script in the count line",
			(s) => void s.subscribe![0]!.count!.item.push("<script>x</script>"),
		],
	];
	for (const [what, change] of refused) {
		it(`refuses ${what}`, () => {
			const s = withFooterControls();
			change(s);
			expect(wpShellProblem(s)).not.toBeNull();
		});
	}
});

describe("the Archives widget", () => {
	const site = wpShellDateSite(withFooterControls());
	const dates = [
		new Date("2023-07-05T12:00:00Z"),
		// 23:30 on July 31 in the site's time zone (Los Angeles): July's
		new Date("2023-08-01T06:30:00Z"),
		new Date("2022-12-18T10:00:00Z"),
	];

	it("is a details whose summary is the list box as the theme drew it, and whose links are the site's months", () => {
		const html = renderArchives(withFooterControls().archives![0]!, dates, site);
		expect(html).toBe(
			'<details class="wp-shell-archives"><summary class="wp-shell-archives-summary">' +
				'<span style="--wp-shell-select-width:153px;" id="archives-dropdown-2" class="wp-shell-field wp-shell-select">Select Month</span>' +
				'</summary><ul class="wp-shell-archives-list">' +
				'<li><a href="/2023/07/">July 2023  (2)</a></li>' +
				'<li><a href="/2022/12/">December 2022  (1)</a></li></ul></details>',
		);
	});

	it("is as wide as its longest line, as a list box is", () => {
		const one = renderArchives(
			withFooterControls().archives![0]!,
			[new Date("2023-07-05T12:00:00Z")],
			site,
		);
		// July 2023 and a no-break space before (1): 80.8px, with the box's 34px: Embark's writer measured the captured box so
		expect(one).toContain("--wp-shell-select-width:115px;");
		const none = renderArchives(withFooterControls().archives![0]!, null, site);
		expect(none).toContain('<ul class="wp-shell-archives-list"></ul>');
		expect(none).toContain(">Select Month</span>");
	});

	it("links each month where the site's permalinks put it: under its front, or by WordPress's query", () => {
		const a = withFooterControls().archives![0]!;
		expect(renderArchives(a, dates, { paths: { front: "/blog/" }, zone: {} })).toContain(
			'href="/blog/2023/08/"',
		);
		expect(renderArchives(a, dates, { paths: { front: "/", plain: true }, zone: {} })).toContain(
			'href="/?m=202307"',
		);
	});

	it("is WordPress's list of links when the widget was one, with its counts after them", () => {
		const html = renderArchives(
			{ as: "list", type: "monthly", count: true, class: "wp-block-archives-list" },
			dates,
			site,
		);
		expect(html).toBe(
			'<ul class="wp-block-archives-list"><li><a href="/2023/07/">July 2023</a>&nbsp;(2)</li>\n<li><a href="/2022/12/">December 2022</a>&nbsp;(1)</li></ul>',
		);
		expect(renderArchives({ as: "list", type: "yearly", count: false }, dates, site)).toBe(
			'<ul><li><a href="/2023/">2023</a></li>\n<li><a href="/2022/">2022</a></li></ul>',
		);
	});

	it("is drawn where the record's slot is, from the dates the layout read", () => {
		const shell = withFooterControls();
		const html = composeWpShell(shell, {
			menuItems: () => null,
			currentPath: "/",
			dates,
			dateSite: site,
		})
			.map((p) => ("html" in p ? p.html : ""))
			.join("");
		expect(html).toContain(
			'<span class="screen-reader-text">Past posts</span><details class="wp-shell-archives">',
		);
		expect(html).toContain('<a href="/2023/07/">July 2023  (2)</a>');
	});
});

describe("a date archive", () => {
	it("is drawn in the record's own layout, with WordPress's archive classes and none of a single entry's", () => {
		const s = sample();
		expect(bodyClassFor(s, "archive")).toBe(
			"archive date wp-theme-twentytwenty enable-search-modal",
		);
		expect(layoutFor(s, "archive")).toBe(s);
	});

	it("is reached at /wp-shell/archive/ with WordPress's own shape of its date", () => {
		expect(wpShellRoute("archive/2023/07")).toEqual({
			kind: "archive",
			archive: { y: 2023, m: 7, page: 1 },
		});
		expect(wpShellRoute("archive/2023/07/page/2")).toEqual({
			kind: "archive",
			archive: { y: 2023, m: 7, page: 2 },
		});
		expect(wpShellRoute("archive/2023/13")).toBeNull();
		expect(wpShellRoute("archive")).toBeNull();
	});

	it("lists its posts in a classic theme's entry markup, dated in the site's time zone, escaped", () => {
		const html = renderArchivePosts(
			[
				{
					title: "Tom & <Jerry>",
					url: "/posts/tom",
					excerpt: "Words & more",
					date: new Date("2023-08-01T06:30:00Z"),
				},
			],
			{ zone: { timeZone: "America/Los_Angeles" } },
		);
		expect(html).toBe(
			'<article class="post type-post status-publish format-standard hentry"><header class="entry-header"><h2 class="entry-title"><a href="/posts/tom" rel="bookmark">Tom &amp; &lt;Jerry&gt;</a></h2>' +
				'<div class="entry-meta"><span class="posted-on"><a href="/posts/tom" rel="bookmark"><time class="entry-date published" datetime="2023-08-01T06:30:00.000Z">July 31, 2023</time></a></span></div></header>' +
				'<div class="entry-summary"><p>Words &amp; more</p></div></article>',
		);
	});

	it("links its other pages as WordPress's posts navigation does", () => {
		const site = { paths: { front: "/" } };
		expect(renderArchiveNav({ y: 2023, m: 7, page: 1 }, false, site)).toBe("");
		expect(renderArchiveNav({ y: 2023, m: 7, page: 2 }, true, site)).toBe(
			'<nav class="navigation posts-navigation" aria-label="Posts"><h2 class="screen-reader-text">Posts navigation</h2><div class="nav-links">' +
				'<div class="nav-previous"><a href="/2023/07/page/3/">Older posts</a></div><div class="nav-next"><a href="/2023/07/">Newer posts</a></div></div></nav>',
		);
	});

	it("takes its time zone from the record, else the site's setting", () => {
		expect(wpShellDateSite(null, "Europe/Paris").zone).toEqual({ timeZone: "Europe/Paris" });
		expect(wpShellDateSite(null, "not a zone").zone).toEqual({});
		expect(
			wpShellDateSite({ dates: { front: "/date/", utcOffset: -480 } }, "Europe/Paris"),
		).toEqual({ paths: { front: "/date/" }, zone: { utcOffset: -480 }, titles: {} });
	});
});

describe("the sign-up", () => {
	const draw = (fill: Partial<Parameters<typeof renderWpShellSubscribe>[1]> = {}) =>
		renderWpShellSubscribe(subscribeSkin(), { ...SUBSCRIBE, status: null, count: null, ...fill });

	it("is a form posting to the subscriptions plugin, in Jetpack's markup, with its own box and button", () => {
		expect(draw({ count: 0 })).toBe(
			'<div class="wp-block-jetpack-subscriptions__container">' +
				'<form method="post" action="/_emdash/api/plugins/emdash-subscriptions/subscribe" accept-charset="utf-8" id="subscribe-blog-blog_subscription-3">' +
				'<input type="hidden" name="source" value="/about/"><input type="hidden" name="fragment" value="subscribe-blog-blog_subscription-3">' +
				'<p aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;"><input type="text" name="website" value="" tabindex="-1" autocomplete="off"></p>' +
				'<div id="subscribe-text"><p>Enter your address to follow this site.</p></div><p id="subscribe-email">' +
				'<label for="subscribe-field-blog_subscription-3" class="screen-reader-text">Email Address</label>' +
				'<input type="email" name="email" autocomplete="email" required id="subscribe-field-blog_subscription-3" placeholder="Email Address">' +
				'</p><p id="subscribe-submit"><button type="submit" class="wp-block-button__link">Subscribe now</button></p></form></div>',
		);
	});

	it("says how many the site's own confirmed subscribers are, as Jetpack says it, and nothing for none", () => {
		expect(draw({ count: 0 })).not.toContain("subscount");
		expect(draw({ count: null })).not.toContain("subscount");
		expect(draw({ count: 1 })).toContain(
			'<div class="wp-block-jetpack-subscriptions__subscount">Join 1 other subscriber</div>',
		);
		expect(draw({ count: 23 })).toContain(">Join 23 other subscribers</div>");
		expect(draw({ count: 1234 })).toContain(">Join 1,234 other subscribers</div>");
		expect(draw({ count: 12_345 })).toContain(">Join 12.3K other subscribers</div>");
		expect(draw({ count: 1_500_000 })).toContain(">Join 1.5M other subscribers</div>");
	});

	it("says what a try did before the form, and draws no fields once the visitor is signed up", () => {
		const saved = draw({ status: "saved" });
		expect(
			saved.startsWith(
				`<div class="success"><p>${WP_SHELL_SUBSCRIBE_MESSAGES.saved!.text}</p></div><div class="wp-block-jetpack-subscriptions__container"><form`,
			),
		).toBe(true);
		expect(saved).not.toContain('name="email"');
		expect(WP_SHELL_SUBSCRIBE_MESSAGES.saved!.text).toContain("no confirmation email was sent");
		const invalid = draw({ status: "invalid_email" });
		expect(
			invalid.startsWith(
				'<p class="error">Oops! The email you used is invalid. Please try again.</p>',
			),
		).toBe(true);
		expect(invalid).toContain('name="email"');
		// a status the plugin never sends says nothing
		expect(draw({ status: "<script>" })).toBe(draw());
	});

	it("has words for every status the sign-up plugin sends back", () => {
		for (const status of SUBSCRIBE_STATUSES)
			expect(WP_SHELL_SUBSCRIBE_MESSAGES[status]).toBeTruthy();
		// a confirmation that failed to send is saved and retried: the visitor is not asked to try again
		const queued = draw({ status: "queued" });
		expect(
			queued.startsWith('<div class="success"><p>Thank you! Your subscription is saved.'),
		).toBe(true);
		expect(queued).not.toContain('name="email"');
	});

	it("escapes what it writes into the form", () => {
		expect(draw({ source: '/a"><script>' })).toContain(
			'name="source" value="/a&quot;&gt;&lt;script&gt;"',
		);
	});

	it("is drawn where the record's slot is only when the site takes sign-ups", () => {
		const shell = withFooterControls();
		const html = (fill: Parameters<typeof composeWpShell>[1]) =>
			composeWpShell(shell, fill)
				.map((p) => ("html" in p ? p.html : ""))
				.join("");
		expect(html({ menuItems: () => null, currentPath: "/" })).not.toContain(
			"jetpack-subscriptions",
		);
		expect(
			html({
				menuItems: () => null,
				currentPath: "/",
				subscribe: { ...SUBSCRIBE, status: null, count: 23 },
			}),
		).toContain(
			'<h4 class="item-title">Follow by email</h4><div class="wp-block-jetpack-subscriptions__container"><form method="post"',
		);
	});
});

// --- a site that is not WordPress, cut from its slot map ----------------------

/** A Substack-shaped record, as Embark's writer cuts one from a slot map: a generic sign-up, a subtitle slot, a posts index. */
function slotMapped(): WpShell {
	const s = sample();
	const at = s.parts.findIndex((p) => "slot" in p && p.slot === "title");
	s.parts.splice(at + 1, 0, { slot: "subtitle", tag: "h3", class: "subtitle" });
	s.parts.push(
		{ html: '<div class="footer-wrap">' },
		{ slot: "subscribe", subscribe: 0 },
		{ html: "</div>" },
	);
	return {
		...s,
		subscribe: [
			{
				plugin: "generic",
				parts: [
					'<div class="subscribe-widget">',
					{ s: "form", class: "form" },
					{ s: "fields" },
					{ s: "/form" },
					"</div>",
				],
				fields: [
					{ s: "control", class: "email-input", placeholder: "Type your email..." },
					{ s: "submit", tag: "button", class: "button primary", label: "Subscribe" },
				],
			},
		],
		listings: [
			{
				count: 3,
				item: [
					'<div class="',
					{ s: "cls" },
					'"><h2 class="article__title"><a href="',
					{ s: "href" },
					'">',
					{ s: "title" },
					'</a></h2><time class="article__date">',
					{ s: "date" },
					'</time><p class="article__excerpt">',
					{ s: "excerpt" },
					"</p></div>",
				],
				classes: ["article col"],
				date: "F j, Y",
				utcOffset: -420,
				excerpt: { words: 55, more: " […]" },
			},
		],
		index: {
			body: { class: "archive-page" },
			styles: ["/_emdash/api/media/file/wp-shell/index1.css"],
			parts: [
				{ html: '<header id="site-header"><nav><ul class="primary-menu">' },
				{ slot: "menu", menu: 0 },
				{ html: '</ul></nav></header><main class="container">' },
				{ slot: "title", tag: "h1", class: "wp-shell-untitled" },
				{ slot: "content", tag: "div", class: "row animate" },
				{ html: "</main>" },
			],
			listing: 0,
		},
	};
}

const drawnPieces = (pieces: ReturnType<typeof composeWpShell>) =>
	pieces
		.map((p) =>
			"html" in p
				? p.html
				: "subtitle" in p
					? `[subtitle ${p.subtitle.tag}.${p.subtitle.class ?? ""}]`
					: "title" in p
						? "[title]"
						: "content" in p
							? "[content]"
							: "[comments]",
		)
		.join("");

describe("a slot map's site: its sign-up, its subtitle and its posts index", () => {
	it("leaves every WordPress record the writer produces as it was: no index route, no subtitle, a Jetpack sign-up", () => {
		for (const r of writerRecords as unknown as WpShell[]) {
			expect(wpShellIndexRoute(r, "?cursor=x")).toBeNull();
			expect(layoutFor(r, "index")).toBe(r);
			expect(JSON.stringify(r)).not.toContain('"subtitle"');
			for (const x of r.subscribe ?? []) expect(x.plugin).toBe("jetpack");
		}
	});

	it("accepts the record the writer cuts from a slot map", () => {
		expect(wpShellProblem(slotMapped())).toBeNull();
	});

	it("draws a generic sign-up posting to the subscriptions plugin, its status line in this layout's own markup, not Jetpack's", () => {
		const x = slotMapped().subscribe![0]!;
		const draw = (status: string | null) =>
			renderWpShellSubscribe(x, { ...SUBSCRIBE, status, count: 12 });
		expect(draw(null)).toBe(
			'<div class="subscribe-widget"><form method="post" action="/_emdash/api/plugins/emdash-subscriptions/subscribe" accept-charset="utf-8" class="form">' +
				'<input type="hidden" name="source" value="/about/">' +
				'<p aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;"><input type="text" name="website" value="" tabindex="-1" autocomplete="off"></p>' +
				'<input type="email" name="email" autocomplete="email" required class="email-input" placeholder="Type your email..."><button type="submit" class="button primary">Subscribe</button></form></div>',
		);
		const sent = draw("sent");
		expect(
			sent.startsWith(
				`<p class="wp-shell-subscribe-status wp-shell-subscribe-ok" role="status">${WP_SHELL_SUBSCRIBE_MESSAGES.sent!.text}</p><div class="subscribe-widget">`,
			),
		).toBe(true);
		expect(sent).not.toContain('name="email"');
		expect(sent).not.toContain('class="success"');
		expect(
			draw("invalid_email").startsWith(
				'<p class="wp-shell-subscribe-status wp-shell-subscribe-error" role="status">Oops! The email you used is invalid.',
			),
		).toBe(true);
		// Jetpack's own skin keeps Jetpack's markup for the same status.
		expect(
			renderWpShellSubscribe(subscribeSkin(), {
				...SUBSCRIBE,
				status: "sent",
				count: null,
			}).startsWith('<div class="success"><p>'),
		).toBe(true);
		// No count line is drawn for a skin that has none, whatever the count.
		expect(draw(null)).not.toContain("12");
	});

	it("draws the subtitle element only for an entry with an excerpt, between the title and the content", () => {
		const pieces = (subtitle: string | null | undefined) =>
			drawnPieces(
				composeWpShell(slotMapped(), {
					menuItems: () => null,
					currentPath: "/posts/x",
					kind: "post",
					subtitle,
				}),
			);
		expect(pieces("The road across the sea ice opens.")).toContain("[title][subtitle h3.subtitle]");
		for (const none of [null, undefined, "", "   "]) {
			expect(pieces(none)).not.toContain("[subtitle");
			expect(pieces(none)).toContain("[title]");
		}
		// A record without a subtitle slot draws none, whatever the entry's excerpt.
		expect(
			drawnPieces(
				composeWpShell(sample(), {
					menuItems: () => null,
					currentPath: "/",
					subtitle: "An excerpt",
				}),
			),
		).not.toContain("[subtitle");
	});

	it("draws the posts index in its own layout and body classes, the posts in the cards' markup, escaped", () => {
		const shell = slotMapped();
		expect(layoutFor(shell, "index")).toBe(shell.index);
		expect(bodyClassFor(shell, "index")).toBe("archive-page");
		expect(stylesFor(shell, "index")).toEqual(["/_emdash/api/media/file/wp-shell/index1.css"]);
		// Without an index, the record's own layout would draw it; the posts route does not come here then.
		const plain = sample();
		expect(layoutFor(plain, "index")).toBe(plain);
		const posts: WpShellPost[] = [
			{
				title: "Ice <roads>",
				url: "/posts/ice-roads",
				excerpt: "The road & the sea.",
				date: new Date("2023-07-23T05:30:00Z"),
			},
			{
				title: "Second",
				url: "/posts/second",
				excerpt: "",
				text: "One two three",
				date: new Date("2023-06-09T12:15:00Z"),
			},
		];
		const site = wpShellDateSite(shell);
		expect(renderIndexPosts(shell, posts, site)).toBe(
			'<div class="article col"><h2 class="article__title"><a href="/posts/ice-roads">Ice &lt;roads&gt;</a></h2><time class="article__date">July 22, 2023</time><p class="article__excerpt">The road &amp; the sea.</p></div>' +
				'<div class="article col"><h2 class="article__title"><a href="/posts/second">Second</a></h2><time class="article__date">June 9, 2023</time><p class="article__excerpt">One two three</p></div>',
		);
		// More posts than the source's page listed are all drawn: a page of the index holds what the site's setting says.
		expect(
			renderIndexPosts(
				shell,
				Array.from({ length: 5 }, (_, i) => ({ title: `P${i}`, url: `/posts/p${i}` })),
				site,
			).match(/article__title/g),
		).toHaveLength(5);
	});

	it("draws plain items, never a card of the source's, where the record's index has no listing", () => {
		const shell = slotMapped();
		delete shell.index!.listing;
		expect(wpShellProblem(shell)).toBeNull();
		const out = renderIndexPosts(
			shell,
			[
				{
					title: "A & B",
					url: "/posts/a",
					excerpt: "Its <own>.",
					date: new Date("2023-07-23T05:30:00Z"),
				},
			],
			wpShellDateSite(shell, "America/Los_Angeles"),
		);
		expect(out).toBe(
			'<article class="wp-shell-index-post"><h2 class="wp-shell-index-title"><a href="/posts/a">A &amp; B</a></h2>' +
				'<p class="wp-shell-index-date"><time datetime="2023-07-23T05:30:00.000Z">July 22, 2023</time></p><p class="wp-shell-index-excerpt">Its &lt;own&gt;.</p></article>',
		);
		expect(out).not.toContain("article__title");
		expect(renderIndexPosts(shell, [], wpShellDateSite(shell))).toBe("");
	});

	it("takes the list the cards hung in as the posts index's content, each plain item one of its items; no other layout's", () => {
		const shell = slotMapped();
		delete shell.index!.listing;
		shell.index!.parts = shell.index!.parts.map((p) =>
			"slot" in p && p.slot === "content" ? { slot: "content", tag: "ul", class: "cards" } : p,
		);
		expect(wpShellProblem(shell)).toBeNull();
		expect(renderIndexPosts(shell, [{ title: "A", url: "/posts/a" }], wpShellDateSite(shell))).toBe(
			'<li class="wp-shell-index-item"><article class="wp-shell-index-post"><h2 class="wp-shell-index-title"><a href="/posts/a">A</a></h2></article></li>',
		);
		const page = slotMapped();
		page.parts = page.parts.map((p) =>
			"slot" in p && p.slot === "content" ? { slot: "content", tag: "ul" } : p,
		);
		expect(wpShellProblem(page)).toBe("the content element is not one this layout draws");
		const title = slotMapped();
		title.index!.parts = title.index!.parts.map((p) =>
			"slot" in p && p.slot === "title" ? { slot: "title", tag: "ul" } : p,
		);
		expect(wpShellProblem(title)).toBe(
			"the posts index: the title element is not one this layout draws",
		);
	});

	it("links the index's other pages: the newest from any later page, the next older one while there is one", () => {
		expect(renderIndexNav(null, null)).toBe("");
		expect(renderIndexNav(null, "abc")).toBe(
			'<nav class="wp-shell-index-nav" aria-label="Posts"><a class="wp-shell-index-older" rel="next" href="/posts?cursor=abc">Older posts</a></nav>',
		);
		expect(renderIndexNav("abc", null)).toBe(
			'<nav class="wp-shell-index-nav" aria-label="Posts"><a class="wp-shell-index-newest" href="/posts">Newest posts</a></nav>',
		);
		expect(renderIndexNav("abc", 'x"y&z')).toContain('href="/posts?cursor=x%22y%26z"');
	});

	const refused: Array<[string, (s: WpShell) => void]> = [
		[
			"a sign-up of a plugin this layout does not know",
			(s) => void ((s.subscribe![0] as { plugin: string }).plugin = "substack"),
		],
		["two subtitle slots in one layout", (s) => void s.parts.push({ slot: "subtitle", tag: "p" })],
		[
			"a subtitle element this layout does not draw",
			(s) =>
				void s.parts.splice(
					s.parts.findIndex((p) => "slot" in p && p.slot === "subtitle"),
					1,
					{ slot: "subtitle", tag: "ul" as "p" },
				),
		],
		[
			"a subtitle with classes that leave their attribute",
			(s) =>
				void s.parts.splice(
					s.parts.findIndex((p) => "slot" in p && p.slot === "subtitle"),
					1,
					{ slot: "subtitle", tag: "p", class: 'x" onclick="y' },
				),
		],
		["a posts index naming no listing", (s) => void (s.index!.listing = 3)],
		[
			"a posts index with no content slot",
			(s) =>
				void (s.index!.parts = s.index!.parts.filter(
					(p) => !("slot" in p) || p.slot !== "content",
				)),
		],
		[
			"a posts index drawing a post's slot",
			(s) => void s.index!.parts.push({ slot: "postMeta", meta: 0 }),
		],
		[
			"a posts index whose markup carries a script",
			(s) => void s.index!.parts.push({ html: "<script>x</script>" }),
		],
		[
			"a posts index stylesheet that is not the site's own",
			(s) => void (s.index!.styles = ["https://evil.example/x.css"]),
		],
	];
	for (const [what, change] of refused) {
		it(`refuses ${what}`, () => {
			const s = slotMapped();
			change(s);
			expect(wpShellProblem(s)).not.toBeNull();
		});
	}
});
