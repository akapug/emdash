/**
 * A migrated WordPress site's own header, footer and CSS, kept as DATA.
 *
 * Embark captures the live WordPress page once, cuts it into this record and
 * stores it as the site option `site:wpShell`. One shared layout,
 * `layouts/WpShell.astro`, draws every page of such a site from the record:
 * WordPress's markup around EmDash's own content. The per-site part is data,
 * so an EmDash upgrade stays one shared rebuild for every site.
 *
 * TRUST. The writer sanitizes every HTML string in the record before it
 * stores it (Embark's `sanitizeFragment`: allow-listed tags and attributes,
 * no scripts, no event handlers, no `<style>` or `<link>` in the body) and
 * runs the CSS through its CSS serializer before it uploads it. This file is
 * not a second sanitizer. It is a TRIPWIRE: a record that shows any sign of
 * executable markup, or a stylesheet that is not one of the site's own
 * uploaded files, is refused whole, and the page falls back to `Base.astro`.
 * Everything this file adds to the markup itself (menu labels and links, the
 * site title) is escaped here.
 *
 * This module is pure (no EmDash runtime import) so the unit tests reach it.
 */

/** The site setting that holds the record: the options row `site:wpShell`. */
export const WP_SHELL_SETTING = "wpShell";

/** The record's schema version. A reader refuses any other. */
export const WP_SHELL_VERSION = 1;

/** Where the record's stylesheets live: the site's own media bucket, under `wp-shell/`. */
export const WP_SHELL_ASSET_PATH = "/_emdash/api/media/file/wp-shell/";

/** An element the layout opens itself, so it can carry EmDash's edit markers. */
export interface WpShellElement {
	tag: WpShellTag;
	class?: string;
	id?: string;
}

/** The tags a title or content element may be. */
export const WP_SHELL_TAGS = [
	"div",
	"section",
	"article",
	"main",
	"header",
	"footer",
	"aside",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"span",
] as const;
export type WpShellTag = (typeof WP_SHELL_TAGS)[number];

/**
 * One piece of the page body, in document order. `html` is captured markup;
 * every other kind is a SLOT the layout fills from EmDash.
 *
 * The html pieces are halves of one sanitized document: a piece may open an
 * element that a later piece closes, and only all of them together, with the
 * slots between them, are well formed.
 */
export type WpShellPart =
	| { html: string }
	| ({ slot: "title" } & WpShellElement)
	| ({ slot: "content" } & WpShellElement)
	| { slot: "siteTitle"; fallback: string }
	| { slot: "tagline"; fallback: string }
	| { slot: "logo"; src: string; alt?: string; class?: string; width?: number; height?: number }
	| { slot: "menu"; menu: number };

/** A piece of a menu item template: captured markup, or a hole this file fills. */
export type WpShellTemplatePart = string | { s: "cls" | "href" | "label" | "children" };

/**
 * One WordPress menu, redrawn from the EmDash menu `location` so an edit in
 * the admin shows on the site. `leaf` and `parent` are the theme's own markup
 * for one item without and with children; `fallback` is the captured items,
 * served only while the site has no such EmDash menu.
 */
export interface WpShellMenu {
	location: string;
	leaf: WpShellTemplatePart[];
	parent: WpShellTemplatePart[];
	fallback: string;
}

export interface WpShell {
	version: typeof WP_SHELL_VERSION;
	/** Content hash of the record, stamped on `<html data-wp-shell>` so a writer can see it served. */
	id: string;
	source: { url: string; capturedAt: string };
	html: { lang?: string; class: string };
	body: { class: string };
	/** The site's stylesheets, in cascade order. */
	styles: string[];
	parts: WpShellPart[];
	menus: WpShellMenu[];
}

/** What a page is, for the body classes WordPress would have given it. */
export type WpShellKind = "home" | "page" | "post";

/** The EmDash menu item shape this file reads. */
export interface WpShellMenuItem {
	label: string;
	url: string;
	target?: string;
	children: WpShellMenuItem[];
}

// --- validation --------------------------------------------------------------

/** Class and id values: WordPress's own tokens, nothing that can leave an attribute. */
const TOKENS = /^[A-Za-z0-9_\- ]*$/;
const STYLE_HREF = /^\/_emdash\/api\/media\/file\/wp-shell\/[a-z0-9]+\.css$/;
const MEDIA_SRC = /^\/_emdash\/api\/media\/file\/[A-Za-z0-9_\-./]+$/;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MENU_LOCATION = /^[a-z0-9_-]{1,64}$/;
const RECORD_ID = /^[a-f0-9]{8,64}$/;
/** The whole record's markup, summed. A page the size of a novel is not a header. */
const MAX_MARKUP = 1_000_000;

/**
 * Executable markup, in any string the record would put on a page. The writer
 * removed all of it; seeing any here means the record did not come from that
 * writer, and none of it is served.
 */
const TRIPWIRE: readonly RegExp[] = [
	/<\s*\/?\s*(script|iframe|object|embed|frame|frameset|base|meta|link|style|form|svg|math|template)\b/i,
	// An attribute follows whitespace, a `/`, or straight after a quoted value.
	/<[^>]*[\s/"']on[a-z]+\s*=/i,
	/<[^>]*=\s*["']?\s*(javascript|vbscript)\s*:/i,
];

const hasExecutableMarkup = (html: string) => TRIPWIRE.some((re) => re.test(html));

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const optionalToken = (v: unknown) => v === undefined || (typeof v === "string" && TOKENS.test(v));

function checkElement(p: Record<string, unknown>): boolean {
	return (
		typeof p.tag === "string" &&
		(WP_SHELL_TAGS as readonly string[]).includes(p.tag) &&
		optionalToken(p.class) &&
		optionalToken(p.id)
	);
}

const isIndex = (v: unknown, below: number): boolean =>
	typeof v === "number" && Number.isInteger(v) && v >= 0 && v < below;

function checkPart(p: unknown, menus: number): string | null {
	if (!isObject(p)) return "a part is not an object";
	if ("html" in p) return typeof p.html === "string" ? null : "an html part is not a string";
	switch (p.slot) {
		case "title":
		case "content":
			return checkElement(p) ? null : `the ${p.slot} element is not one this layout draws`;
		case "siteTitle":
		case "tagline":
			return typeof p.fallback === "string" ? null : `the ${p.slot} slot has no fallback`;
		case "logo":
			return typeof p.src === "string" &&
				MEDIA_SRC.test(p.src) &&
				optionalToken(p.class) &&
				(p.alt === undefined || typeof p.alt === "string") &&
				(p.width === undefined || isIndex(p.width, 10_000)) &&
				(p.height === undefined || isIndex(p.height, 10_000))
				? null
				: "the logo is not one of the site's own files";
		case "menu":
			return isIndex(p.menu, menus) ? null : "a menu slot names no menu";
		default:
			return `unknown slot ${JSON.stringify(p.slot)}`;
	}
}

const TEMPLATE_HOLES = new Set(["cls", "href", "label", "children"]);

function checkTemplate(t: unknown): t is WpShellTemplatePart[] {
	return (
		Array.isArray(t) &&
		t.every((x) => typeof x === "string" || (isObject(x) && typeof x.s === "string" && TEMPLATE_HOLES.has(x.s)))
	);
}

/**
 * href is filled INSIDE a double-quoted attribute, and nowhere else: the piece
 * before it must end the attribute's opening. renderMenu relies on it to add
 * `target` and `rel` after the value.
 */
const hrefInAttribute = (t: WpShellTemplatePart[]) =>
	t.every((x, i) => {
		if (typeof x === "string" || x.s !== "href") return true;
		const before = t[i - 1];
		return typeof before === "string" && before.endsWith('href="');
	});

function checkMenu(m: unknown): string | null {
	if (!isObject(m)) return "a menu is not an object";
	if (typeof m.location !== "string" || !MENU_LOCATION.test(m.location)) return "a menu has no location";
	const { leaf, parent } = m;
	if (!checkTemplate(leaf) || !checkTemplate(parent)) return "a menu template is malformed";
	if (typeof m.fallback !== "string") return "a menu has no fallback";
	if (!hrefInAttribute(leaf) || !hrefInAttribute(parent)) return "a menu link is not inside an href attribute";
	return null;
}

/** Every markup string a record carries. */
function markupOf(s: WpShell): string[] {
	const out: string[] = [];
	for (const p of s.parts) if ("html" in p) out.push(p.html);
	for (const m of s.menus) {
		out.push(m.fallback);
		for (const x of [...m.leaf, ...m.parent]) if (typeof x === "string") out.push(x);
	}
	return out;
}

const countSlot = (parts: unknown[], slot: string) => parts.filter((p) => isObject(p) && p.slot === slot).length;

/** Why `value` is not a shell record this layout can draw, or null when it is one. */
export function wpShellProblem(value: unknown): string | null {
	if (!isObject(value)) return "not an object";
	if (value.version !== WP_SHELL_VERSION) return `version ${String(value.version)} is not ${WP_SHELL_VERSION}`;
	if (typeof value.id !== "string" || !RECORD_ID.test(value.id)) return "no id";
	if (!isObject(value.source) || typeof value.source.url !== "string") return "no source";
	const { html, body, styles, menus, parts } = value;
	if (!isObject(html) || typeof html.class !== "string" || !TOKENS.test(html.class)) {
		return "html attributes are not tokens";
	}
	if (html.lang !== undefined && (typeof html.lang !== "string" || !LANG.test(html.lang))) {
		return "html lang is not a language tag";
	}
	if (!isObject(body) || typeof body.class !== "string" || !TOKENS.test(body.class)) {
		return "body class is not tokens";
	}
	if (!Array.isArray(styles) || !styles.every((h) => typeof h === "string" && STYLE_HREF.test(h))) {
		return "a stylesheet is not one of the site's own files";
	}
	if (!Array.isArray(menus)) return "no menus";
	for (const m of menus) {
		const why = checkMenu(m);
		if (why) return why;
	}
	if (!Array.isArray(parts)) return "no parts";
	for (const p of parts) {
		const why = checkPart(p, menus.length);
		if (why) return why;
	}
	if (countSlot(parts, "title") !== 1 || countSlot(parts, "content") !== 1) {
		return "the record needs exactly one title and one content slot";
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- every field was checked above
	const markup = markupOf(value as unknown as WpShell);
	if (markup.reduce((n, h) => n + h.length, 0) > MAX_MARKUP) return "the markup is larger than a shell";
	if (markup.some(hasExecutableMarkup)) return "the markup carries something executable";
	return null;
}

/** The record, or null when there is none or it is not one this layout can draw. */
export function parseWpShell(value: unknown): WpShell | null {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- wpShellProblem checked the shape
	return value !== undefined && wpShellProblem(value) === null ? (value as WpShell) : null;
}

/**
 * Settings are cached per isolate and handed out as the same object until
 * they expire, so the check runs once per record per isolate, not per request.
 */
const checked = new WeakMap<object, WpShell | null>();

export function parseWpShellCached(value: unknown, warn: (why: string) => void = () => {}): WpShell | null {
	if (!isObject(value)) {
		if (value !== undefined) warn("not an object");
		return null;
	}
	const hit = checked.get(value);
	if (hit !== undefined) return hit;
	const why = wpShellProblem(value);
	if (why) warn(why);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- wpShellProblem checked the shape
	const shell = why ? null : (value as unknown as WpShell);
	checked.set(value, shell);
	return shell;
}

// --- rendering helpers -------------------------------------------------------

const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const QUOT = /"/g;
const APOS = /'/g;

export function escapeHtml(s: string): string {
	return s.replace(AMP, "&amp;").replace(LT, "&lt;").replace(GT, "&gt;");
}

export function escapeAttr(s: string): string {
	return escapeHtml(s).replace(QUOT, "&quot;").replace(APOS, "&#39;");
}

/** What a browser strips from a URL before it reads the scheme. */
const URL_CONTROLS = /[\u0000-\u001F\u007F]/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FOLLOWABLE_SCHEME = /^(https?|mailto|tel):/i;

/** A menu link a visitor may follow: http(s), mailto, tel, or a URL with no scheme. */
export function safeHref(url: string): string {
	const v = url.replace(URL_CONTROLS, "").trim();
	if (v === "") return "#";
	if (!SCHEME.test(v)) return v;
	return FOLLOWABLE_SCHEME.test(v) ? v : "#";
}

const TRAILING_SLASHES = /\/+$/;
const QUERY_OR_FRAGMENT = /[?#]/;

/** A path without its trailing slash, so `/about/` and `/about` are one page. */
const normalPath = (p: string) => (p.length > 1 ? p.replace(TRAILING_SLASHES, "") : p);

/**
 * Whether a menu item links to the page being drawn. EmDash resolves a menu
 * item that names an entry to a path on this site; an absolute URL is a custom
 * link, and this file cannot know it names this host, so it is never current.
 */
export function isCurrent(url: string, currentPath: string): boolean {
	if (!url.startsWith("/") || url.startsWith("//")) return false;
	const path = url.split(QUERY_OR_FRAGMENT, 1)[0] ?? url;
	return normalPath(path) === normalPath(currentPath);
}

function fillTemplate(
	t: WpShellTemplatePart[],
	item: WpShellMenuItem,
	current: string,
	children: string,
): string {
	let out = "";
	for (const x of t) {
		if (typeof x === "string") {
			out += x;
			continue;
		}
		if (x.s === "label") out += escapeHtml(item.label);
		else if (x.s === "children") out += children;
		else if (x.s === "cls") out += isCurrent(item.url, current) ? " current-menu-item" : "";
		else {
			out += escapeAttr(safeHref(item.url));
			// The template put this hole inside `href="…"`, so the attribute is
			// closed here and the new ones are written whole, quoted.
			if (item.target === "_blank") out += '" target="_blank" rel="noopener noreferrer';
		}
	}
	return out;
}

/**
 * The items of one WordPress menu, drawn from an EmDash menu in the theme's own
 * markup. With no EmDash menu, the captured items.
 */
export function renderMenu(
	menu: WpShellMenu,
	items: readonly WpShellMenuItem[] | null | undefined,
	currentPath: string,
): string {
	if (!items) return menu.fallback;
	const draw = (list: readonly WpShellMenuItem[]): string =>
		list
			.map((item) =>
				item.children.length > 0
					? fillTemplate(menu.parent, item, currentPath, draw(item.children))
					: fillTemplate(menu.leaf, item, currentPath, ""),
			)
			.join("");
	return draw(items);
}

/** What the layout draws: markup, or the element that holds the title or the content. */
export type WpShellPiece = { html: string } | { title: WpShellElement } | { content: WpShellElement };

/** What EmDash knows that the record left a slot for. */
export interface WpShellFill {
	/** The site title setting; unset keeps the captured one. */
	siteTitle?: string | null;
	tagline?: string | null;
	/** The logo setting's resolved URL; unset keeps the captured logo. */
	logoUrl?: string | null;
	/** The EmDash menu at `location`, or null when the site has none. */
	menuItems: (location: string) => readonly WpShellMenuItem[] | null | undefined;
	/** The path of the page being drawn, for the current menu item. */
	currentPath: string;
}

const element = (p: WpShellElement): WpShellElement => ({
	tag: p.tag,
	...(p.class !== undefined ? { class: p.class } : {}),
	...(p.id !== undefined ? { id: p.id } : {}),
});

function logoHtml(p: Extract<WpShellPart, { slot: "logo" }>, url: string | null | undefined): string {
	const src = url && safeHref(url) !== "#" ? url : p.src;
	const attrs = [
		`src="${escapeAttr(src)}"`,
		`alt="${escapeAttr(p.alt ?? "")}"`,
		p.class ? `class="${escapeAttr(p.class)}"` : "",
		p.width ? `width="${p.width}"` : "",
		p.height ? `height="${p.height}"` : "",
	].filter(Boolean);
	return `<img ${attrs.join(" ")}>`;
}

/**
 * The record's parts with every slot but the title and the content filled,
 * and neighbouring markup joined: what the layout draws, in order.
 */
export function composeWpShell(shell: WpShell, fill: WpShellFill): WpShellPiece[] {
	const out: WpShellPiece[] = [];
	const push = (html: string) => {
		const last = out.at(-1);
		if (last && "html" in last) last.html += html;
		else out.push({ html });
	};
	for (const p of shell.parts) {
		if ("html" in p) push(p.html);
		else if (p.slot === "title") out.push({ title: element(p) });
		else if (p.slot === "content") out.push({ content: element(p) });
		else if (p.slot === "siteTitle") push(escapeHtml(fill.siteTitle ?? p.fallback));
		else if (p.slot === "tagline") push(escapeHtml(fill.tagline ?? p.fallback));
		else if (p.slot === "logo") push(logoHtml(p, fill.logoUrl));
		else {
			const menu = shell.menus[p.menu];
			push(renderMenu(menu, fill.menuItems(menu.location), fill.currentPath));
		}
	}
	return out;
}

/**
 * WordPress's body classes for this kind of page. The record keeps the classes
 * of the page it was captured from, without the ones that named that page; the
 * ones that say what kind of page this is are put back per request.
 */
const KIND_CLASSES: Record<WpShellKind, readonly string[]> = {
	home: ["home", "page", "page-template-default"],
	page: ["page", "page-template-default"],
	post: ["single", "single-post", "single-format-standard"],
};
const ANY_KIND = new Set(Object.values(KIND_CLASSES).flat());
const WHITESPACE = /\s+/;

export function bodyClassFor(shell: WpShell, kind: WpShellKind): string {
	const kept = shell.body.class.split(WHITESPACE).filter((c) => c !== "" && !ANY_KIND.has(c));
	return [...KIND_CLASSES[kind], ...kept].join(" ");
}

/** Which page a rewritten `/wp-shell/...` path draws, or null for any other path. */
export function wpShellRoute(
	path: string | undefined,
): { kind: "home" } | { kind: "page" | "post"; slug: string } | null {
	const segments = (path ?? "").split("/").filter(Boolean);
	if (segments.length === 1 && segments[0] === "home") return { kind: "home" };
	if (segments.length !== 2) return null;
	const [collection, slug] = segments;
	if (collection === "pages") return { kind: "page", slug };
	if (collection === "posts") return { kind: "post", slug };
	return null;
}
