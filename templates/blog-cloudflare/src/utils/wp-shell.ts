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
	| { slot: "menu"; menu: number }
	/** The entry's title as text, where the chrome prints it: a breadcrumb trail's last crumb. */
	| { slot: "titleText" }
	/** The site's latest posts, where the front page lists them: the record's `listings[listing]`. */
	| { slot: "listing"; listing: number };

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
	/** The classes the theme gives the item for the page being shown (a Bootstrap walker's `active`); `current-menu-item` when unset. */
	current?: string;
}

/** A hole in a listing item's markup, filled for each post here. */
export type WpShellListingHole = "cls" | "href" | "title" | "excerpt" | "date" | "thumb" | "src";
export type WpShellListingPart = string | { s: WpShellListingHole };

/**
 * The site's latest posts, drawn where the front page listed them, in the
 * theme's own markup for one item. The title, excerpt and date are text, and
 * escaped here; the link is the post's, and a thumbnail is drawn only for a
 * post whose featured image is one of the site's own files.
 */
export interface WpShellListing {
	/** How many posts WordPress showed. */
	count: number;
	item: WpShellListingPart[];
	/** The thumbnail, drawn at the item's `thumb` hole, with a `src` hole. */
	thumb?: WpShellListingPart[];
	/** The item's class at each position; the last holds for the rest. */
	classes: string[];
	/** How an item prints its date, in PHP date() letters (`F j, Y`). */
	date?: string;
	/** The site's time zone: an IANA name, or a fixed offset from UTC in minutes. */
	timeZone?: string;
	utcOffset?: number;
	/**
	 * An excerpt made from a post's content: its words, and what ends one that
	 * was cut; `paragraphs` when the theme prints the excerpt's paragraphs.
	 */
	excerpt: { words: number; more: string; paragraphs?: true };
	/**
	 * The theme laid the items out as masonry, each into its shortest column:
	 * the items after the first `from` are drawn in `columns` lanes (the
	 * record's stylesheet holds them at `min` px and wider), each post into the
	 * lane an estimate of its height says is the shortest.
	 */
	lanes?: WpShellLanes;
}

/** A listing's masonry as lanes, and what estimates an item's height in them. */
export interface WpShellLanes {
	columns: number;
	from: number;
	min: number;
	estimate: {
		titleChars: number;
		titleLine: number;
		textChars: number;
		textLine: number;
		paragraph: number;
		base: number;
		thumbWidth: number;
	};
}

/** One layout of the site: the body classes, stylesheets and parts a page is drawn with. */
export interface WpShellLayout {
	body: { class: string };
	/** The site's stylesheets, in cascade order. */
	styles: string[];
	parts: WpShellPart[];
}

export interface WpShell extends WpShellLayout {
	version: typeof WP_SHELL_VERSION;
	/** Content hash of the record, stamped on `<html data-wp-shell>` so a writer can see it served. */
	id: string;
	source: { url: string; capturedAt: string };
	html: { lang?: string; class: string };
	menus: WpShellMenu[];
	/** The listings the layouts' `listing` slots draw. */
	listings?: WpShellListing[];
	/**
	 * The front page's own layout, when it wears one (a theme's full-width
	 * front page): the home is drawn from it instead of the record's own body,
	 * stylesheets and parts. The menus are the record's.
	 */
	home?: WpShellLayout;
	/** Pages cut on their own (a page on a template of its own, a page with a form): each drawn for the page of its slug. */
	pages?: WpShellPageLayout[];
	/** The site's forms in their plugin's markup: an EmDash form imported from one is drawn in it (renderWpShellForm). */
	forms?: WpShellForm[];
}

/** A page's own layout, for the EmDash page of its slug. */
export interface WpShellPageLayout extends WpShellLayout {
	slug: string;
}

/** The field types a form's skin draws. */
export const WP_SHELL_FORM_TYPES = [
	"text",
	"email",
	"tel",
	"url",
	"number",
	"date",
	"textarea",
	"select",
	"checkbox",
	"radio",
	"checkbox-group",
] as const;

/**
 * A field of a form's skin, as the importer made the EmDash field: the skin
 * is drawn only for a form whose fields are these, so an admin's edit to one
 * (its label, whether it is required) shows, in EmDash's own form.
 */
export interface WpShellFormField {
	/** The EmDash field's name, when the plugin gives the importer one; the label otherwise. */
	name?: string;
	label: string;
	type: (typeof WP_SHELL_FORM_TYPES)[number];
	required: boolean;
	help?: string;
	/** A choice field's number of choices. */
	options?: number;
}

/** A hole in a form's skin: EmDash's form element, a field's control, a label for it, the submit control. */
export type WpShellFormHole =
	| { s: "form"; class?: string }
	| { s: "/form" }
	| { s: "control"; field: number; option?: number; class?: string; rows?: number; cols?: number }
	| { s: "label"; field?: number; option?: number; class?: string }
	| { s: "/label" }
	/** Where a field's error message goes: the end of its container, where the plugin wrote its own. */
	| { s: "error"; field: number }
	| { s: "submit"; tag: "button" | "input"; class?: string };
export type WpShellFormPart = string | WpShellFormHole;

/** One of the site's forms as its plugin drew it, with holes for EmDash's form. */
export interface WpShellForm {
	plugin: "gravityforms" | "jetpack";
	fields: WpShellFormField[];
	parts: WpShellFormPart[];
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
 * THE TRIPWIRE. The writer's markup comes out of one serializer (linkedom,
 * behind Embark's sanitizer) in one form: every tag complete, every attribute
 * value double-quoted with `"`, `<` and `>` escaped, no comments, and no
 * entity but the five it writes. A string in any other form did not come from
 * that writer. A pattern over a string in an unknown form guesses where a
 * browser sees a tag, and loses (`<a title=">" onclick=…>`, `&#106;avascript:`,
 * `java&#x09;script:`, a tag cut in two by a slot), so the FORM is checked, and
 * inside it every tag and attribute is read the way a browser reads it.
 *
 * Each piece is checked on its own, so every slot boundary sits between tags;
 * a menu template is checked with its holes filled, the label and children
 * holes with markup that only fits between tags.
 */
const CANONICAL_TAG =
	// eslint-disable-next-line no-control-regex -- an attribute name holds no control character
	/<(\/?)([a-z][a-z0-9-]*)((?:\s+[^\s"'<>/=\u0000-\u001F]+(?:="[^"<>]*")?)*)\s*\/?>/y;
// eslint-disable-next-line no-control-regex -- an attribute name holds no control character
const ATTRIBUTE = /\s+([^\s"'<>/=\u0000-\u001F]+)(?:="([^"<>]*)")?/g;

/** Elements the writer never emits: they run, fetch, submit, or change how what follows them is parsed. */
const NEVER_TAGS = new Set([
	"script",
	"iframe",
	"object",
	"embed",
	"frame",
	"frameset",
	"base",
	"meta",
	"link",
	"style",
	"form",
	"svg",
	"math",
	"template",
	"noscript",
	"noembed",
	"noframes",
	"xmp",
	"plaintext",
	"textarea",
	"title",
	"select",
	"option",
	"input",
	"button",
	"portal",
	"applet",
	"isindex",
	"param",
	"dialog",
]);
/** Attributes the writer never emits. */
const NEVER_ATTRS = new Set([
	"action",
	"formaction",
	"background",
	"ping",
	"srcdoc",
	"data",
	"codebase",
	"dynsrc",
	"lowsrc",
]);

const ENTITY = /&(?:(amp|lt|gt|quot|#39);)?/g;
const ENTITY_VALUE: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/** An attribute value as a browser reads it, or null when it holds an entity the writer never writes. */
function decodeValue(v: string): string | null {
	let ok = true;
	const out = v.replace(ENTITY, (_, name: string | undefined) => {
		if (!name) ok = false;
		return name ? (ENTITY_VALUE[name] ?? "") : "&";
	});
	return ok ? out : null;
}

/** A stand-in page on the site, to resolve a reference the way the page will. */
const SITE = "https://site.invalid";
const PAGE = `${SITE}/a/page`;
const MEDIA_PATH = "/_emdash/api/media/file/";
const IMG_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon);base64,/i;
const STYLE_DATA = /^data:(image|font|application)\//i;

/** Whether a page on the site would load `url` from the site's own files. */
function ownFile(url: string): boolean {
	const u = URL.parse(url, PAGE);
	return u !== null && u.origin === SITE && u.pathname.startsWith(MEDIA_PATH);
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const URL_NOISE = /[\u0000-\u0020\u007F]/g;
const RUNNING_SCHEME = /^(javascript|vbscript|data):/i;
/** An id the visual-editing toolbar looks itself up by (`getElementById("emdash-toolbar")`). */
const EMDASH_ID = /^\s*emdash/i;
const CSS_ESCAPE = /\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n])/g;
const CSS_RUNS = /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import/i;
const CSS_URL = /url\(\s*(["']?)([^"')]*)/gi;
const CSS_STRING_URL = /image-set\s*\(|(?:^|[^a-z0-9_-])(?:image|src)\s*\(/i;

function styleProblem(css: string): string | null {
	const v = css.replace(CSS_ESCAPE, (_, hex: string | undefined, ch: string | undefined) =>
		hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : (ch ?? ""),
	);
	if (CSS_RUNS.test(v)) return "a style attribute runs script";
	for (const m of v.matchAll(CSS_URL)) {
		const url = (m[2] ?? "").trim();
		if (!STYLE_DATA.test(url) && !ownFile(url))
			return "a style attribute loads from outside the site";
	}
	return CSS_STRING_URL.test(v) ? "a style attribute names a URL outside url()" : null;
}

function attributeProblem(tag: string, name: string, value: string): string | null {
	if (
		name.startsWith("on") ||
		NEVER_ATTRS.has(name) ||
		(name.includes(":") && !name.startsWith("data-"))
	) {
		return `the markup carries a ${name} attribute`;
	}
	if (name.startsWith("data-emdash") || (name === "id" && EMDASH_ID.test(value))) {
		return "the markup claims to be EmDash's own";
	}
	if (name === "href")
		return RUNNING_SCHEME.test(value.replace(URL_NOISE, "")) ? "a link runs script" : null;
	if (name === "src" || name === "poster") {
		return ((tag === "img" || tag === "source") && IMG_DATA.test(value.trim())) || ownFile(value)
			? null
			: `a ${name} loads from outside the site`;
	}
	if (name === "srcset") return "the markup carries a srcset";
	return name === "style" ? styleProblem(value) : null;
}

/** Why `html` is not markup the writer produced, or null. */
function markupProblem(html: string): string | null {
	for (let i = html.indexOf("<"); i !== -1; i = html.indexOf("<", CANONICAL_TAG.lastIndex)) {
		CANONICAL_TAG.lastIndex = i;
		const m = CANONICAL_TAG.exec(html);
		if (!m) return "the markup is not in the writer's form";
		const tag = m[2] ?? "";
		if (NEVER_TAGS.has(tag)) return `the markup carries a <${tag}>`;
		for (const a of (m[3] ?? "").matchAll(ATTRIBUTE)) {
			const value = a[2] === undefined ? "" : decodeValue(a[2]);
			if (value === null) return "an attribute value is not in the writer's form";
			const why = attributeProblem(tag, (a[1] ?? "").toLowerCase(), value);
			if (why) return why;
		}
	}
	return null;
}

/** Holes filled for the check: a label or children hole takes markup, which only fits between tags. */
const HOLE_FILL: Record<string, string> = {
	cls: "",
	href: "#",
	label: "<b></b>",
	children: "<b></b>",
};

/** Every layout a record draws pages with. */
const layoutsOf = (s: WpShell): WpShellLayout[] => [
	s,
	...(s.home ? [s.home] : []),
	...(s.pages ?? []),
];

/**
 * A listing's holes filled for the check: its links and image with values the
 * tripwire reads as the site's, its text holes with markup that only fits
 * between tags, and its thumbnail with the thumbnail's own markup.
 */
const LISTING_FILL: Record<WpShellListingHole, string> = {
	cls: "",
	href: "#",
	src: "/_emdash/api/media/file/a.png",
	title: "<b></b>",
	excerpt: "<b></b>",
	date: "<b></b>",
	thumb: "<b></b>",
};

function fillForCheck(t: WpShellListingPart[], thumb: string): string {
	return t
		.map((x) => (typeof x === "string" ? x : x.s === "thumb" ? thumb : LISTING_FILL[x.s]))
		.join("");
}

/** Every markup string the layout draws, each as the tripwire must read it. */
function drawnMarkup(s: WpShell): string[] {
	const out: string[] = [];
	for (const l of layoutsOf(s)) for (const p of l.parts) if ("html" in p) out.push(p.html);
	for (const m of s.menus) {
		out.push(m.fallback);
		for (const t of [m.leaf, m.parent])
			out.push(t.map((x) => (typeof x === "string" ? x : HOLE_FILL[x.s])).join(""));
	}
	for (const l of s.listings ?? []) {
		const thumb = l.thumb ? fillForCheck(l.thumb, "") : "";
		out.push(fillForCheck(l.item, thumb), fillForCheck(l.item, ""));
	}
	// A form's holes as elements that fit between tags: renderWpShellForm writes the form's own.
	for (const f of s.forms ?? []) out.push(f.parts.map(formFillForCheck).join(""));
	return out;
}

const FORM_FILL: Record<WpShellFormHole["s"], string> = {
	form: "<div>",
	"/form": "</div>",
	control: "<b></b>",
	label: "<b>",
	"/label": "</b>",
	error: "<b></b>",
	submit: "<b></b>",
};
const formFillForCheck = (x: WpShellFormPart) => (typeof x === "string" ? x : FORM_FILL[x.s]);

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

function checkPart(p: unknown, menus: number, listings: number): string | null {
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
		case "titleText":
			return null;
		case "listing":
			return isIndex(p.listing, listings) ? null : "a listing slot names no listing";
		default:
			return `unknown slot ${JSON.stringify(p.slot)}`;
	}
}

const TEMPLATE_HOLES = new Set(["cls", "href", "label", "children"]);

function checkTemplate(t: unknown): t is WpShellTemplatePart[] {
	return (
		Array.isArray(t) &&
		t.every(
			(x) =>
				typeof x === "string" ||
				(isObject(x) && typeof x.s === "string" && TEMPLATE_HOLES.has(x.s)),
		)
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
	if (typeof m.location !== "string" || !MENU_LOCATION.test(m.location))
		return "a menu has no location";
	const { leaf, parent } = m;
	if (!checkTemplate(leaf) || !checkTemplate(parent)) return "a menu template is malformed";
	if (typeof m.fallback !== "string") return "a menu has no fallback";
	if (!optionalToken(m.current)) return "a menu's current classes are not tokens";
	if (!hrefInAttribute(leaf) || !hrefInAttribute(parent))
		return "a menu link is not inside an href attribute";
	return null;
}

const ITEM_HOLES = new Set(["cls", "href", "title", "excerpt", "date", "thumb"]);
const THUMB_HOLES = new Set(["href", "src"]);
/** What each attribute hole is filled inside, and only there. */
const IN_ATTRIBUTE: Record<string, string> = { cls: 'class="', href: 'href="', src: 'src="' };
const DATE_FORMAT = /^[FMjdmnYS ,./-]{1,20}$/;
const TIME_ZONE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;
const MAX_LISTED = 50;

/** A listing template: markup and holes of `allowed` kinds, each attribute hole inside its attribute. */
function checkListingTemplate(t: unknown, allowed: ReadonlySet<string>): boolean {
	return (
		Array.isArray(t) &&
		t.every((x, i) => {
			if (typeof x === "string") return true;
			if (!isObject(x) || typeof x.s !== "string" || !allowed.has(x.s)) return false;
			const attribute = IN_ATTRIBUTE[x.s];
			const before = t[i - 1];
			return attribute === undefined || (typeof before === "string" && before.endsWith(attribute));
		})
	);
}

function checkListing(l: unknown): string | null {
	if (!isObject(l)) return "a listing is not an object";
	if (
		typeof l.count !== "number" ||
		!Number.isInteger(l.count) ||
		l.count < 1 ||
		l.count > MAX_LISTED
	)
		return "a listing's count is not a count";
	if (!checkListingTemplate(l.item, ITEM_HOLES)) return "a listing's item template is malformed";
	if (l.thumb !== undefined && !checkListingTemplate(l.thumb, THUMB_HOLES))
		return "a listing's thumbnail template is malformed";
	const { classes, date, timeZone, utcOffset, excerpt } = l;
	if (
		!Array.isArray(classes) ||
		classes.length === 0 ||
		!classes.every((c) => typeof c === "string" && TOKENS.test(c))
	)
		return "a listing's classes are not tokens";
	if (date !== undefined && (typeof date !== "string" || !DATE_FORMAT.test(date)))
		return "a listing's date format is not one";
	if (timeZone !== undefined && (typeof timeZone !== "string" || !TIME_ZONE.test(timeZone)))
		return "a listing's time zone is not one";
	if (
		utcOffset !== undefined &&
		(typeof utcOffset !== "number" || !Number.isInteger(utcOffset) || Math.abs(utcOffset) > 840)
	)
		return "a listing's offset from UTC is not one";
	if (
		!isObject(excerpt) ||
		typeof excerpt.words !== "number" ||
		!Number.isInteger(excerpt.words) ||
		excerpt.words < 1 ||
		excerpt.words > 1000 ||
		typeof excerpt.more !== "string" ||
		excerpt.more.length > 20 ||
		(excerpt.paragraphs !== undefined && excerpt.paragraphs !== true)
	)
		return "a listing's excerpt rule is not one";
	if (l.lanes !== undefined && !checkLanes(l.lanes, l.count))
		return "a listing's lanes are not ones";
	return null;
}

const LANE_ESTIMATE = [
	"titleChars",
	"titleLine",
	"textChars",
	"textLine",
	"paragraph",
	"base",
	"thumbWidth",
];

function checkLanes(v: unknown, count: number): boolean {
	if (!isObject(v) || !isObject(v.estimate)) return false;
	const { estimate } = v;
	return (
		isIndex(v.columns, 13) &&
		v.columns !== 0 &&
		isIndex(v.from, count + 1) &&
		isIndex(v.min, 10_000) &&
		LANE_ESTIMATE.every((k) => {
			const n = estimate[k];
			return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10_000;
		})
	);
}

/** Every markup string a record carries. */
function markupOf(s: WpShell): string[] {
	const out: string[] = [];
	for (const l of layoutsOf(s)) for (const p of l.parts) if ("html" in p) out.push(p.html);
	for (const m of s.menus) {
		out.push(m.fallback);
		for (const x of [...m.leaf, ...m.parent]) if (typeof x === "string") out.push(x);
	}
	for (const l of s.listings ?? [])
		for (const x of [...l.item, ...(l.thumb ?? [])]) if (typeof x === "string") out.push(x);
	for (const f of s.forms ?? []) for (const x of f.parts) if (typeof x === "string") out.push(x);
	return out;
}

const FORM_PLUGINS = new Set(["gravityforms", "jetpack"]);
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const PAGE_SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const MAX_FORM_FIELDS = 100;
const isText = (v: unknown): v is string => typeof v === "string";

function checkFormField(f: unknown): boolean {
	return (
		isObject(f) &&
		(f.name === undefined || (isText(f.name) && FIELD_NAME.test(f.name))) &&
		isText(f.label) &&
		f.label.length <= 500 &&
		isText(f.type) &&
		(WP_SHELL_FORM_TYPES as readonly string[]).includes(f.type) &&
		typeof f.required === "boolean" &&
		(f.help === undefined || (isText(f.help) && f.help.length <= 2000)) &&
		(f.options === undefined || isIndex(f.options, 101))
	);
}

/** Why a form's skin is not one this layout draws, or null. */
function checkForm(f: unknown): string | null {
	if (!isObject(f)) return "a form is not an object";
	if (!isText(f.plugin) || !FORM_PLUGINS.has(f.plugin))
		return "a form's plugin is not one this layout draws";
	const { fields, parts } = f;
	if (
		!Array.isArray(fields) ||
		fields.length === 0 ||
		fields.length > MAX_FORM_FIELDS ||
		!fields.every(checkFormField)
	)
		return "a form's fields are malformed";
	if (!Array.isArray(parts)) return "a form has no parts";
	const count: Record<string, number> = {};
	let depth = 0;
	for (const [i, x] of parts.entries()) {
		if (isText(x)) continue;
		if (!isObject(x) || !isText(x.s) || !(x.s in FORM_FILL))
			return "a form's hole is not one this layout fills";
		count[x.s] = (count[x.s] ?? 0) + 1;
		if (!optionalToken(x.class)) return "a form's classes are not tokens";
		if (x.field !== undefined && !isIndex(x.field, fields.length))
			return "a form's hole names no field";
		const field: unknown = typeof x.field === "number" ? fields[x.field] : undefined;
		const options = isObject(field) && typeof field.options === "number" ? field.options : 1;
		if (x.option !== undefined && !isIndex(x.option, options))
			return "a form's hole names no choice";
		if ((x.s === "control" || x.s === "error") && x.field === undefined)
			return "a form's hole names no field";
		if (
			(x.rows !== undefined && !isIndex(x.rows, 1000)) ||
			(x.cols !== undefined && !isIndex(x.cols, 1000))
		)
			return "a form's text box size is not one";
		if (x.s === "submit" && x.tag !== "button" && x.tag !== "input")
			return "a form's submit control is not one";
		if (x.s === "label") depth++;
		if (x.s === "/label" && --depth < 0) return "a form's labels do not nest";
		// Every hole sits between tags, never inside one.
		const before = parts
			.slice(0, i)
			.map((y) => (isText(y) ? y : "X"))
			.join("");
		if (before.lastIndexOf("<") > before.lastIndexOf(">")) return "a form's hole is inside a tag";
	}
	if (count.form !== 1 || count["/form"] !== 1 || count.submit !== 1 || depth !== 0)
		return "a form needs one form element and one submit control";
	return null;
}

const countSlot = (parts: unknown[], slot: string) =>
	parts.filter((p) => isObject(p) && p.slot === slot).length;

/** Why a layout's body, stylesheets or parts are not ones this template draws, or null. */
function checkLayout(l: Record<string, unknown>, menus: number, listings: number): string | null {
	const { body, styles, parts } = l;
	if (!isObject(body) || typeof body.class !== "string" || !TOKENS.test(body.class)) {
		return "body class is not tokens";
	}
	if (!Array.isArray(styles) || !styles.every((h) => typeof h === "string" && STYLE_HREF.test(h))) {
		return "a stylesheet is not one of the site's own files";
	}
	if (!Array.isArray(parts)) return "no parts";
	for (const p of parts) {
		const why = checkPart(p, menus, listings);
		if (why) return why;
	}
	if (countSlot(parts, "title") !== 1 || countSlot(parts, "content") !== 1) {
		return "the record needs exactly one title and one content slot";
	}
	return null;
}

/** Why `value` is not a shell record this layout can draw, or null when it is one. */
export function wpShellProblem(value: unknown): string | null {
	if (!isObject(value)) return "not an object";
	if (value.version !== WP_SHELL_VERSION)
		return `version ${String(value.version)} is not ${WP_SHELL_VERSION}`;
	if (typeof value.id !== "string" || !RECORD_ID.test(value.id)) return "no id";
	if (!isObject(value.source) || typeof value.source.url !== "string") return "no source";
	const { html, body, styles, menus, parts } = value;
	if (!isObject(html) || typeof html.class !== "string" || !TOKENS.test(html.class)) {
		return "html attributes are not tokens";
	}
	if (html.lang !== undefined && (typeof html.lang !== "string" || !LANG.test(html.lang))) {
		return "html lang is not a language tag";
	}
	if (!Array.isArray(menus)) return "no menus";
	for (const m of menus) {
		const why = checkMenu(m);
		if (why) return why;
	}
	const { listings = [] } = value;
	if (!Array.isArray(listings)) return "the listings are not a list";
	for (const l of listings) {
		const why = checkListing(l);
		if (why) return why;
	}
	const layout = checkLayout({ body, styles, parts }, menus.length, listings.length);
	if (layout) return layout;
	if (value.home !== undefined) {
		const why = isObject(value.home)
			? checkLayout(value.home, menus.length, listings.length)
			: "not an object";
		if (why) return `the home layout: ${why}`;
	}
	const { pages = [], forms = [] } = value;
	if (!Array.isArray(pages)) return "the pages are not a list";
	const slugs = new Set<string>();
	for (const pg of pages) {
		if (!isObject(pg) || !isText(pg.slug) || !PAGE_SLUG.test(pg.slug) || slugs.has(pg.slug))
			return "a page layout names no page";
		slugs.add(pg.slug);
		const why = checkLayout(pg, menus.length, listings.length);
		if (why) return `the ${pg.slug} page layout: ${why}`;
	}
	if (!Array.isArray(forms)) return "the forms are not a list";
	for (const f of forms) {
		const why = checkForm(f);
		if (why) return why;
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- every field was checked above
	const shell = value as unknown as WpShell;
	if (markupOf(shell).reduce((n, h) => n + h.length, 0) > MAX_MARKUP)
		return "the markup is larger than a shell";
	for (const piece of drawnMarkup(shell)) {
		const why = markupProblem(piece);
		if (why) return why;
	}
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

export function parseWpShellCached(
	value: unknown,
	warn: (why: string) => void = () => {},
): WpShell | null {
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
// eslint-disable-next-line no-control-regex -- matching control characters is the point
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
	currentClass: string,
): string {
	let out = "";
	for (const x of t) {
		if (typeof x === "string") {
			out += x;
			continue;
		}
		if (x.s === "label") out += escapeHtml(item.label);
		else if (x.s === "children") out += children;
		else if (x.s === "cls") out += isCurrent(item.url, current) ? ` ${currentClass}` : "";
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
	const currentClass = menu.current ?? "current-menu-item";
	const draw = (list: readonly WpShellMenuItem[]): string =>
		list
			.map((item) =>
				item.children.length > 0
					? fillTemplate(menu.parent, item, currentPath, draw(item.children), currentClass)
					: fillTemplate(menu.leaf, item, currentPath, "", currentClass),
			)
			.join("");
	return draw(items);
}

// --- a listing ----------------------------------------------------------------

/** One post a listing draws, as layouts/WpShell.astro reads it from EmDash. */
export interface WpShellPost {
	title: string;
	/** The featured image's height over its width, when EmDash knows its size (a listing's lanes estimate by it). */
	imageRatio?: number | null;
	/** The post's path on the site. */
	url: string;
	/** The post's own excerpt; with none, one is made from `text`. */
	excerpt?: string | null;
	/** The post's content as plain text, a blank line between its paragraphs. */
	text?: string | null;
	date?: Date | null;
	/** The featured image's path, when it is one of the site's own files. */
	image?: string | null;
}

const WORDS = /\s+/;
const PARAGRAPHS = /\n\s*\n/;

/**
 * The post's excerpt as WordPress prints one, paragraph by paragraph: its
 * own, or its first words and the more marker when there were more. One
 * paragraph unless the theme prints an excerpt's paragraphs.
 */
export function listingExcerpt(post: WpShellPost, rule: WpShellListing["excerpt"]): string[] {
	const own = (post.excerpt ?? "").trim();
	const paragraphs = (own || (post.text ?? ""))
		.split(PARAGRAPHS)
		.map((p) => p.split(WORDS).filter(Boolean))
		.filter((p) => p.length > 0);
	const out: string[] = [];
	let left = own ? Number.POSITIVE_INFINITY : rule.words;
	let cut = false;
	for (const words of paragraphs) {
		cut = left <= 0 || words.length > left;
		if (left > 0) out.push(words.slice(0, left).join(" "));
		if (cut) break;
		left -= words.length;
	}
	if (cut) out[out.length - 1] += rule.more;
	return rule.paragraphs || out.length === 0 ? out : [out.join(" ")];
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const ordinal = (d: number) =>
	d % 10 === 1 && d !== 11
		? "st"
		: d % 10 === 2 && d !== 12
			? "nd"
			: d % 10 === 3 && d !== 13
				? "rd"
				: "th";

/** The calendar day `date` falls on in the site's time zone (UTC when it has none, or an unknown one). */
function dayIn(
	date: Date,
	zone: { timeZone?: string; utcOffset?: number },
): { y: number; m: number; d: number } {
	if (zone.timeZone) {
		try {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: zone.timeZone,
				year: "numeric",
				month: "numeric",
				day: "numeric",
			}).formatToParts(date);
			const part = (type: string) => Number(parts.find((x) => x.type === type)?.value);
			return { y: part("year"), m: part("month"), d: part("day") };
		} catch {
			// An unknown zone: UTC, below.
		}
	}
	const t = new Date(date.getTime() + (zone.utcOffset ?? 0) * 60_000);
	return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** A date as PHP's date() prints it with `format`'s letters (F M j d m n Y S); anything else is literal. */
export function formatWpDate(
	date: Date,
	format: string,
	zone: { timeZone?: string; utcOffset?: number } = {},
): string {
	const { y, m, d } = dayIn(date, zone);
	const letters: Record<string, string> = {
		F: MONTH_NAMES[m - 1] ?? "",
		M: (MONTH_NAMES[m - 1] ?? "").slice(0, 3),
		j: String(d),
		d: String(d).padStart(2, "0"),
		n: String(m),
		m: String(m).padStart(2, "0"),
		Y: String(y),
		S: ordinal(d),
	};
	return Array.from(format, (ch) => letters[ch] ?? ch).join("");
}

/** A template piece's markup; a hole has none. */
const markup = (y: WpShellListingPart | undefined) => (typeof y === "string" ? y : "");

function fillListing(
	t: readonly WpShellListingPart[],
	listing: WpShellListing,
	post: WpShellPost,
	at: number,
): string {
	let out = "";
	for (const [i, x] of t.entries()) {
		if (typeof x === "string") {
			out += x;
			continue;
		}
		if (x.s === "cls")
			// In lanes, each item also says its place, which orders the items where the lanes do not hold.
			out += escapeAttr(
				`${listing.classes[Math.min(at, listing.classes.length - 1)] ?? ""}${listing.lanes ? ` wp-shell-at-${at}` : ""}`,
			);
		else if (x.s === "href") out += escapeAttr(safeHref(post.url));
		else if (x.s === "title") out += escapeHtml(post.title);
		else if (x.s === "excerpt") {
			// Paragraphs only where the hole sits in a <p> of its own, which each one closes and reopens.
			const inP = markup(t[i - 1]).endsWith("<p>") && markup(t[i + 1]).startsWith("</p>");
			out += listingExcerpt(post, listing.excerpt)
				.map(escapeHtml)
				.join(inP ? "</p><p>" : " ");
		} else if (x.s === "date")
			out +=
				post.date && listing.date ? escapeHtml(formatWpDate(post.date, listing.date, listing)) : "";
		else if (x.s === "src") out += escapeAttr(post.image ?? "");
		// The thumbnail only for an image that is one of the site's own files.
		else if (listing.thumb && thumbDrawn(listing, post))
			out += fillListing(listing.thumb, listing, post, at);
	}
	return out;
}

/** Whether a post's thumbnail is drawn: an image of the site's own files, where the listing draws one. */
const thumbDrawn = (listing: WpShellListing, post: WpShellPost) =>
	Boolean(listing.thumb && post.image && ownFile(post.image) && MEDIA_SRC.test(post.image));

/** The lines `n` letters take at `per` to a line: one at least. */
const linesOf = (n: number, per: number) => Math.max(1, Math.ceil(n / Math.max(per, 1)));

/** The height an item of `post` is estimated to draw at in a listing's lanes (WpShellLanes.estimate). */
export function laneHeight(listing: WpShellListing, post: WpShellPost): number {
	const e = listing.lanes?.estimate;
	if (!e) return 0;
	const text = listingExcerpt(post, listing.excerpt);
	const ratio =
		typeof post.imageRatio === "number" && post.imageRatio > 0 && post.imageRatio < 10
			? post.imageRatio
			: 0.75;
	return (
		e.base +
		e.titleLine * linesOf(post.title.length, e.titleChars) +
		e.textLine * linesOf(text.join("").length, e.textChars) +
		e.paragraph * Math.max(0, text.length - 1) +
		(thumbDrawn(listing, post) ? e.thumbWidth * ratio : 0)
	);
}

/**
 * A listing's items: as many of `posts` as WordPress listed, each in the
 * theme's markup. In lanes (the theme's masonry), the first `from` items,
 * then each lane with the posts the theme's rule puts in it: each post in
 * turn into the lane whose estimated height is the least, the leftmost of
 * equals.
 */
export function renderListing(listing: WpShellListing, posts: readonly WpShellPost[]): string {
	const shown = posts.slice(0, listing.count);
	const lanes = listing.lanes;
	if (!lanes) return shown.map((post, i) => fillListing(listing.item, listing, post, i)).join("");
	const heights: number[] = Array.from<number>({ length: lanes.columns }).fill(0);
	const into: string[][] = heights.map(() => []);
	let lead = "";
	for (const [i, post] of shown.entries()) {
		const html = fillListing(listing.item, listing, post, i);
		if (i < lanes.from) {
			lead += html;
			continue;
		}
		const lane = heights.indexOf(Math.min(...heights));
		into[lane]?.push(html);
		heights[lane] = (heights[lane] ?? 0) + laneHeight(listing, post);
	}
	return lead + into.map((items) => `<div class="wp-shell-lane">${items.join("")}</div>`).join("");
}

/** Portable Text as plain text: each text block's spans, a blank line between blocks. */
export function plainText(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	return blocks
		.flatMap((b) =>
			isObject(b) && b._type === "block" && Array.isArray(b.children)
				? [b.children.map((c) => (isObject(c) && isText(c.text) ? c.text : "")).join("")]
				: [],
		)
		.join("\n\n");
}

/** A local media value's storage key, as EmDashMedia reads it: its meta's, else its id. */
function storageKeyOf(image: Record<string, unknown>): string | null {
	if (image.provider !== undefined && image.provider !== "local") return null;
	if (isObject(image.meta) && isText(image.meta.storageKey) && image.meta.storageKey)
		return image.meta.storageKey;
	return isText(image.id) && image.id ? image.id : null;
}

/** A featured image's path, when it is one of the site's own files: a bare path, or a media value's. */
export function ownImagePath(image: unknown): string | null {
	const key = isObject(image) && !isText(image.src) ? storageKeyOf(image) : null;
	const path = isText(image)
		? image
		: isObject(image) && isText(image.src)
			? image.src
			: key
				? `${MEDIA_PATH}${key}`
				: null;
	return path && ownFile(path) && MEDIA_SRC.test(path) ? path : null;
}

const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const VIMEO_ID = /vimeo\.com\/(\d+)/;
const HTTP_URL = /^https?:\/\//i;

/**
 * The player WordPress draws for a video link alone on its line in classic
 * content (components/WpShellEmbed.astro): a YouTube or Vimeo embed that
 * carries no block markup (a Gutenberg embed block's `html`), as the player
 * EmDash's own Embed draws for it. Null for any other embed.
 */
export function classicVideoEmbed(
	node: unknown,
): { src: string; title: string; allow: string } | null {
	if (!isObject(node) || !isText(node.url) || !HTTP_URL.test(node.url.trim())) return null;
	const blockMarkup = isText(node.html) && node.html.trim() !== "";
	if (blockMarkup || node.provider === "video" || node.provider === "audio") return null;
	const url = node.url.trim();
	const youtube = YOUTUBE_ID.exec(url)?.[1];
	if (youtube)
		return {
			src: `https://www.youtube.com/embed/${youtube}`,
			title: "YouTube video",
			allow:
				"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
		};
	const vimeo = VIMEO_ID.exec(url)?.[1];
	return vimeo
		? {
				src: `https://player.vimeo.com/video/${vimeo}`,
				title: "Vimeo video",
				allow: "autoplay; fullscreen; picture-in-picture",
			}
		: null;
}

/** A featured image's height over its width, when its media value says its size (WpShellPost.imageRatio). */
export function imageRatio(image: unknown): number | null {
	if (!isObject(image)) return null;
	const { width, height } = image;
	return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
		? height / width
		: null;
}

// --- a form in its plugin's markup ---------------------------------------------

/** An EmDash form field, as the forms plugin's public definition gives it. */
export interface WpShellFormDefinitionField {
	type: string;
	name: string;
	label: string;
	required: boolean;
	placeholder?: string;
	helpText?: string;
	defaultValue?: string;
	options?: Array<{ label: string; value: string }>;
	validation?: {
		minLength?: number;
		maxLength?: number;
		min?: number;
		max?: number;
		pattern?: string;
	};
	condition?: unknown;
}

/** An EmDash form, as the forms plugin's public definition gives it (loadPublicFormDefinition). */
export interface WpShellFormDefinition {
	pages: Array<{ fields: WpShellFormDefinitionField[] }>;
	settings: { spamProtection: string; submitLabel: string };
	_turnstileSiteKey?: string | null;
}

/** A skin, and the EmDash field each of its fields is. */
export interface WpShellFormMatch {
	form: WpShellForm;
	fields: WpShellFormDefinitionField[];
}

const squeezed = (s: string | undefined) => (s ?? "").replace(WHITESPACE_RUN, " ").trim();
const WHITESPACE_RUN = /\s+/g;

/**
 * The skin an EmDash form is drawn in: the site's form whose fields are this
 * form's, as the importer made them (the same names or labels, types, labels,
 * required fields, help texts and choices). Null for any other form, one of
 * several pages, with a condition, a file or a hidden field of its own, or one
 * an admin has changed: it is drawn in EmDash's own markup, and the change
 * shows.
 */
export function formSkin(shell: WpShell, def: WpShellFormDefinition): WpShellFormMatch | null {
	if (def.pages.length !== 1) return null;
	const fields = def.pages[0]?.fields ?? [];
	if (fields.some((f) => f.condition !== undefined || f.type === "file")) return null;
	const shown = fields.filter((f) => f.type !== "hidden");
	for (const form of shell.forms ?? []) {
		if (form.fields.length !== shown.length) continue;
		const used = new Set<WpShellFormDefinitionField>();
		const matched = form.fields.map((sf) => {
			const f = shown.find(
				(x) =>
					!used.has(x) && (sf.name ? x.name === sf.name : squeezed(x.label) === squeezed(sf.label)),
			);
			if (!f) return null;
			used.add(f);
			const same =
				f.type === sf.type &&
				squeezed(f.label) === squeezed(sf.label) &&
				f.required === sf.required &&
				squeezed(f.helpText) === squeezed(sf.help) &&
				(sf.options === undefined || (f.options?.length ?? 0) === sf.options);
			return same ? f : null;
		});
		const fields = matched.filter((f) => f !== null);
		if (fields.length === matched.length) return { form, fields };
	}
	return null;
}

const attr = (name: string, value: string | number | boolean | undefined) =>
	value === undefined || value === false
		? ""
		: value === true
			? ` ${name}`
			: ` ${name}="${escapeAttr(String(value))}"`;

/** A field's control, as the forms plugin's FormEmbed draws it, with the skin's classes. */
function formControl(
	f: WpShellFormDefinitionField,
	hole: Extract<WpShellFormHole, { s: "control" }>,
	id: string,
): string {
	const cls = attr("class", hole.class);
	const v = f.validation ?? {};
	if (f.type === "textarea") {
		return `<textarea${cls}${attr("id", id)}${attr("name", f.name)}${attr("placeholder", f.placeholder)}${attr("required", f.required)}${attr("minlength", v.minLength)}${attr("maxlength", v.maxLength)}${attr("rows", hole.rows)}${attr("cols", hole.cols)}>${escapeHtml(f.defaultValue ?? "")}</textarea>`;
	}
	if (f.type === "select") {
		const options = f.options ?? [];
		const chosen = options.some((o) => o.value === f.defaultValue);
		const prompt = f.placeholder
			? `<option value=""${attr("disabled", true)}${attr("selected", !chosen)}>${escapeHtml(f.placeholder)}</option>`
			: "";
		const list = options
			.map(
				(o) =>
					`<option${attr("value", o.value)}${attr("selected", o.value === f.defaultValue)}>${escapeHtml(o.label)}</option>`,
			)
			.join("");
		return `<select${cls}${attr("id", id)}${attr("name", f.name)}${attr("required", f.required)}>${prompt}${list}</select>`;
	}
	if (f.type === "checkbox") {
		return `<input type="checkbox"${cls}${attr("id", id)}${attr("name", f.name)}${attr("value", f.defaultValue || "1")}${attr("required", f.required)}>`;
	}
	if (f.type === "radio" || f.type === "checkbox-group") {
		const o = f.options?.[hole.option ?? 0];
		const type = f.type === "radio" ? "radio" : "checkbox";
		return `<input type="${type}"${cls}${attr("id", id)}${attr("name", f.name)}${attr("value", o?.value ?? "")}${attr("checked", f.type === "radio" && o !== undefined && o.value === f.defaultValue)}${attr("required", f.type === "radio" && f.required)}>`;
	}
	return `<input${attr("type", f.type)}${cls}${attr("id", id)}${attr("name", f.name)}${attr("placeholder", f.placeholder)}${attr("required", f.required)}${attr("minlength", v.minLength)}${attr("maxlength", v.maxLength)}${attr("min", v.min)}${attr("max", v.max)}${attr("pattern", v.pattern)}${attr("value", f.defaultValue)}>`;
}

/**
 * An EmDash form drawn in its site's plugin's markup (formSkin): the skin's
 * captured markup, and in its holes the form as the forms plugin's FormEmbed
 * draws it: the same element, action, input names and values, validation,
 * spam checks (the honeypot, Turnstile), hidden fields and status line, so
 * what it submits and where is EmDash's. Every value is escaped here.
 */
export function renderWpShellForm(
	match: WpShellFormMatch,
	def: WpShellFormDefinition,
	o: { formId: string; submitUrl: string },
): string {
	const { form, fields } = match;
	// A choice's control has an id of its own; a field of one control, the field's (FormEmbed's).
	const idOf = (field: number, option?: number) =>
		`${o.formId}-${fields[field]?.name ?? ""}${form.fields[field]?.options === undefined ? "" : `-${option ?? 0}`}`;
	const errorLine = (f: WpShellFormDefinitionField) =>
		`<output class="ec-form-error"${attr("data-error-for", f.name)} aria-live="polite"></output>`;
	const placed = new Set(
		form.parts.flatMap((x) => (typeof x !== "string" && x.s === "error" ? [x.field] : [])),
	);
	let out = "";
	for (const x of form.parts) {
		if (typeof x === "string") {
			out += x;
			continue;
		}
		if (x.s === "error") {
			const f = fields[x.field];
			if (f) out += errorLine(f);
		} else if (x.s === "form") {
			out += `<form${attr("class", x.class)} method="POST"${attr("action", o.submitUrl)}${attr("data-form-id", o.formId)} data-ec-form${attr("data-ec-skin", form.plugin)}><div data-page="0" style="display:contents">`;
		} else if (x.s === "/form") {
			const spam = def.settings.spamProtection;
			const hp = `${o.formId}-_hp`;
			out += "</div>";
			if (spam === "honeypot")
				out += `<div class="ec-form-field" style="position:absolute;left:-9999px;" aria-hidden="true"><label${attr("for", hp)}>Leave blank</label><input type="text"${attr("id", hp)} name="_hp" tabindex="-1" autocomplete="off"></div>`;
			if (spam === "turnstile" && def._turnstileSiteKey)
				out += `<div class="ec-form-turnstile" data-ec-turnstile${attr("data-sitekey", def._turnstileSiteKey)}></div>`;
			for (const h of def.pages[0]?.fields.filter((f) => f.type === "hidden") ?? [])
				out += `<input type="hidden"${attr("name", h.name)}${attr("value", h.defaultValue)}>`;
			out += `<input type="hidden" name="formId"${attr("value", o.formId)}><div class="ec-form-status" data-form-status aria-live="polite"></div></form>`;
		} else if (x.s === "control") {
			const f = fields[x.field];
			if (!f) continue;
			out += formControl(f, x, idOf(x.field, x.option));
			// The field's error line, where the forms plugin's client writes a message: where the skin
			// puts it, else after its last control. An <output>: a plugin's rules for the spans of its
			// fields (Gravity Forms' complex fields draw every span a block) would draw an empty span.
			const choices = form.fields[x.field]?.options;
			if (!placed.has(x.field) && (choices === undefined || (x.option ?? 0) === choices - 1))
				out += errorLine(f);
		} else if (x.s === "label") {
			out += `<label${x.field === undefined ? "" : attr("for", idOf(x.field, x.option))}${attr("class", x.class)}>`;
		} else if (x.s === "/label") {
			out += "</label>";
		} else {
			const label = def.settings.submitLabel || "Submit";
			const cls = [x.class, "ec-form-submit"].filter(Boolean).join(" ");
			out +=
				x.tag === "input"
					? `<input type="submit"${attr("class", cls)}${attr("value", label)}>`
					: `<button type="submit"${attr("class", cls)}>${escapeHtml(label)}</button>`;
		}
	}
	return out;
}

/** What the layout draws: markup, or the element that holds the title or the content. */
export type WpShellPiece =
	| { html: string }
	| { title: WpShellElement }
	| { content: WpShellElement };

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
	/** What kind of page is drawn: the home draws the record's home layout when it has one. */
	kind?: WpShellKind;
	/** The page's slug: a page cut on its own draws its own layout. */
	slug?: string | null;
	/** The entry's title, for the chrome that prints it as text (titleText). */
	title?: string;
	/** The site's latest posts, newest first, for a listing slot. */
	posts?: readonly WpShellPost[] | null;
}

/** The layout a kind of page is drawn with: a page of a slug cut on its own draws its own. */
export function layoutFor(shell: WpShell, kind: WpShellKind, slug?: string | null): WpShellLayout {
	if (kind === "home" && shell.home) return shell.home;
	const own = kind === "page" && slug ? shell.pages?.find((p) => p.slug === slug) : undefined;
	return own ?? shell;
}

const element = (p: WpShellElement): WpShellElement => ({
	tag: p.tag,
	...(p.class !== undefined ? { class: p.class } : {}),
	...(p.id !== undefined ? { id: p.id } : {}),
});

function logoHtml(
	p: Extract<WpShellPart, { slot: "logo" }>,
	url: string | null | undefined,
): string {
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
	for (const p of layoutFor(shell, fill.kind ?? "page", fill.slug).parts) {
		if ("html" in p) push(p.html);
		else if (p.slot === "titleText") push(escapeHtml(fill.title ?? ""));
		else if (p.slot === "title") out.push({ title: element(p) });
		else if (p.slot === "content") out.push({ content: element(p) });
		else if (p.slot === "siteTitle") push(escapeHtml(fill.siteTitle ?? p.fallback));
		else if (p.slot === "tagline") push(escapeHtml(fill.tagline ?? p.fallback));
		else if (p.slot === "logo") push(logoHtml(p, fill.logoUrl));
		else if (p.slot === "listing") {
			const listing = shell.listings?.[p.listing];
			if (listing) push(renderListing(listing, fill.posts ?? []));
		} else {
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

export function bodyClassFor(shell: WpShell, kind: WpShellKind, slug?: string | null): string {
	// The home layout was cut from the front page, a page layout from its page: their classes are their own.
	const own = layoutFor(shell, kind, slug);
	if (own !== shell) return own.body.class;
	const kept = shell.body.class.split(WHITESPACE).filter((c) => c !== "" && !ANY_KIND.has(c));
	return [...KIND_CLASSES[kind], ...kept].join(" ");
}

/**
 * The document title of a page drawn in the migrated design. A carried SEO
 * title (the entry's own SEO title, imported from WordPress's SEO plugin) is
 * printed exactly as written, as WordPress printed it; EmDash's getSeoMeta
 * would add " | Site" to it. With none, EmDash's title, with the site's name
 * after it unless it ends with it already.
 */
export function wpShellDocumentTitle(
	title: string,
	siteTitle: string,
	carried?: string | null,
): string {
	if (carried && carried.trim() !== "") return carried;
	const named =
		!siteTitle ||
		title === siteTitle ||
		title.endsWith(` | ${siteTitle}`) ||
		title.endsWith(` \u2014 ${siteTitle}`);
	return named ? title : `${title} \u2014 ${siteTitle}`;
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
