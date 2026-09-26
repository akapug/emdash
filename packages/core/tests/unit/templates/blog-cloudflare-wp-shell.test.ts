import { describe, expect, it, vi } from "vitest";

import {
	bodyClassFor,
	composeWpShell,
	isCurrent,
	parseWpShell,
	parseWpShellCached,
	renderMenu,
	safeHref,
	wpShellProblem,
	wpShellRoute,
	type WpShell,
	type WpShellMenu,
} from "../../../../../templates/blog-cloudflare/src/utils/wp-shell";

/** A Twenty Twenty shaped record, as Embark's writer produces it. */
function sample(): WpShell {
	const menu: WpShellMenu = {
		location: "primary",
		leaf: ['<li class="menu-item', { s: "cls" }, '"><a href="', { s: "href" }, '">', { s: "label" }, "</a></li>"],
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
			{ html: '</ul></nav></header><main id="site-content"><article class="page type-page"><header class="entry-header">' },
			{ slot: "title", tag: "h1", class: "entry-title" },
			{ html: '</header><div class="post-inner thin">' },
			{ slot: "content", tag: "div", class: "entry-content" },
			{ html: "</div></article></main><footer id=\"site-footer\"></footer>" },
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
		["an event handler", (s) => void s.parts.unshift({ html: '<img src="/x.png" onerror="alert(1)">' })],
		["an event handler after a slash", (s) => void s.parts.unshift({ html: "<img/onerror=alert(1) src=x>" })],
		["an event handler after a quoted value", (s) => void s.parts.unshift({ html: '<img src="x"onerror=alert(1)>' })],
		["a javascript: link", (s) => void s.parts.unshift({ html: '<a href=" javascript:alert(1)">x</a>' })],
		["an iframe", (s) => void s.parts.unshift({ html: '<iframe src="https://evil.example"></iframe>' })],
		["a stylesheet in the body", (s) => void s.parts.unshift({ html: '<link rel="stylesheet" href="https://evil.example/x.css">' })],
		["a style element", (s) => void s.parts.unshift({ html: "<style>body{}</style>" })],
		["a stylesheet on another host", (s) => void (s.styles = ["https://old-host.example/style.css"])],
		["a stylesheet outside wp-shell/", (s) => void (s.styles = ["/_emdash/api/media/file/other.css"])],
		["two title slots", (s) => void s.parts.push({ slot: "title", tag: "h1" })],
		["no content slot", (s) => void (s.parts = s.parts.filter((p) => !("slot" in p) || p.slot !== "content"))],
		["a title tag it does not draw", (s) => void s.parts.splice(7, 1, { slot: "title", tag: "script" as "h1" })],
		["a class that leaves its attribute", (s) => void s.parts.splice(7, 1, { slot: "title", tag: "h1", class: 'x" onclick="y' })],
		["a body class that leaves its attribute", (s) => void (s.body.class = 'x" onload="y')],
		["a menu slot naming no menu", (s) => void s.parts.push({ slot: "menu", menu: 3 })],
		["a menu link outside an href", (s) => void (s.menus[0]!.leaf = ["<li>", { s: "href" }, "</li>"])],
		["executable markup in a menu template", (s) => void s.menus[0]!.leaf.unshift('<a onmouseover="x">')],
		["executable markup in a menu fallback", (s) => void (s.menus[0]!.fallback = "<script>x</script>")],
		["a logo from another host", (s) => void s.parts.push({ slot: "logo", src: "https://old-host.example/logo.png" })],
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
		expect(pieces.map((p) => Object.keys(p)[0])).toEqual(["html", "title", "html", "content", "html"]);
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
		s.parts.unshift({ slot: "logo", src: "/_emdash/api/media/file/wp-shell/logo1.png", alt: "Logo", class: "custom-logo", width: 120, height: 40 });
		const drawn = (fill: { logoUrl?: string | null }) =>
			(composeWpShell(s, { ...fill, menuItems: () => null, currentPath: "/" })[0] as { html: string }).html;
		expect(drawn({})).toMatch(/^<img src="\/_emdash\/api\/media\/file\/wp-shell\/logo1.png" alt="Logo" class="custom-logo" width="120" height="40">/);
		expect(drawn({ logoUrl: "/_emdash/api/media/file/new.png" })).toMatch(/^<img src="\/_emdash\/api\/media\/file\/new.png"/);
		expect(drawn({ logoUrl: "javascript:x" })).toMatch(/^<img src="\/_emdash\/api\/media\/file\/wp-shell\/logo1.png"/);
	});

	it("gives each kind of page WordPress's body classes for it", () => {
		const s = sample();
		s.body.class = "home page page-template-default wp-theme-twentytwenty singular";
		expect(bodyClassFor(s, "home")).toBe("home page page-template-default wp-theme-twentytwenty singular");
		expect(bodyClassFor(s, "page")).toBe("page page-template-default wp-theme-twentytwenty singular");
		expect(bodyClassFor(s, "post")).toBe("single single-post single-format-standard wp-theme-twentytwenty singular");
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
