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

import {
	archiveGroups,
	archiveLabel,
	DATE_FRONT,
	datePath,
	dayIn,
	MONTH_NAMES,
	parseDatePath,
	type WpDateArchive,
	type WpDatePaths,
	type WpZone,
} from "./wp-archive";
import declaredFeatures from "./wp-shell-features.json";

/** The record capabilities this reader draws; Embark reads the same checked-in file from the artifact. */
export const WP_SHELL_FEATURES: readonly string[] = declaredFeatures;

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
	| { slot: "listing"; listing: number }
	/** WordPress's Archives widget, its months drawn from EmDash's posts: the record's `archives[archives]`. */
	| { slot: "archives"; archives: number }
	/** A sign-up for new posts by email, posting to EmDash: the record's `subscribe[subscribe]`. */
	| { slot: "subscribe"; subscribe: number }
	// Only in the record's post layout (WpShellPostLayout); anywhere else the record is refused.
	/** The post's meta: the post layout's `meta[meta]`. */
	| { slot: "postMeta"; meta: number }
	/** The post's featured image: the post layout's `featured`. */
	| { slot: "featured" }
	/** The post's first category, where a breadcrumb trail names it: the post layout's `trailTerm`. */
	| { slot: "trailTerm" }
	/** EmDash's comments and comment form, drawn inside the theme's comment element. */
	| ({ slot: "comments" } & WpShellElement)
	/** The post author's bio: the post layout's `author`. */
	| { slot: "authorBio" }
	/** The links to the posts before and after: the post layout's `adjacent`. */
	| { slot: "adjacent" };

/**
 * A hole in a post layout's templates, filled here for each post. Text
 * (escaped): date, author, title, label, count, name, adjTitle. Each inside
 * its own attribute: href, src, alt, adjHref, and the share links (this
 * file's own share page for the network, for the post). Markup, drawn only
 * from the record's own sub-templates: categories, tags, comments, terms,
 * avatar, prev, next; and bio, the byline's paragraphs, each in a `<p>`
 * written here.
 */
export type WpShellPostHole =
	| "href"
	| "date"
	| "author"
	| "title"
	| "categories"
	| "tags"
	| "comments"
	| "count"
	| "terms"
	| "label"
	| "src"
	| "alt"
	| "share-x"
	| "share-facebook"
	| "share-linkedin"
	| "share-email"
	| "name"
	| "bio"
	| "avatar"
	| "prev"
	| "next"
	| "adjHref"
	| "adjTitle";
export type WpShellPostPart = string | { s: WpShellPostHole };

/** A post's terms of one taxonomy: the markup around them (drawn when the post has one), one term, and what joins two. */
export interface WpShellPostTerms {
	item: WpShellPostPart[];
	term: WpShellPostPart[];
	sep: string;
}

/**
 * The layout every single post is drawn in, cut from one of the site's posts:
 * a layout like any other, and the theme's markup for what WordPress's
 * single-post template prints around the content, with holes each post's own
 * values fill.
 */
export interface WpShellPostLayout extends WpShellLayout {
	/** How the meta prints a date, in PHP date() letters, and the site's time zone. */
	date?: string;
	timeZone?: string;
	utcOffset?: number;
	/** The meta blocks, each drawn at its `postMeta` slot. */
	meta: WpShellPostPart[][];
	terms?: { category?: WpShellPostTerms; tag?: WpShellPostTerms };
	/** The comment count link, drawn for a count whose phrase the record knows ("%d Comments"). */
	comments?: { item: WpShellPostPart[]; zero?: string; one?: string; many?: string };
	/** The featured image, drawn for an image of the site's own at least `minWidth` px wide. */
	featured?: { item: WpShellPostPart[]; minWidth: number };
	/** The trail's category crumb, and what follows it. */
	trailTerm?: WpShellPostPart[];
	/** The theme's share links, drawn at the end of the content. */
	share?: WpShellPostPart[];
	/** The author's bio: their name and bio text, and their avatar where they have one. */
	author?: { item: WpShellPostPart[]; avatar?: WpShellPostPart[] };
	/** The links to the posts before and after: each side drawn for a post that has one. */
	adjacent?: { item: WpShellPostPart[]; prev: WpShellPostPart[]; next: WpShellPostPart[] };
	/** The theme's comment area, EmDash's comments and comment form drawn in it (renderWpShellComments). */
	commentArea?: WpShellCommentArea;
}

/** The fields of EmDash's comment form a theme's reply form has a box for. */
export const WP_SHELL_COMMENT_FIELDS = ["body", "authorName", "authorEmail"] as const;
export type WpShellCommentField = (typeof WP_SHELL_COMMENT_FIELDS)[number];

/**
 * A hole in a comment area's templates. The area: where the count heading,
 * the list and the reply block go. The heading: its phrase. A list: its
 * comments (`items`). One comment: its classes and id (each inside its
 * attribute), its author, date (and time) and words, its replies. The reply block:
 * EmDash's form element, a field's box and label (`field`, from the area's
 * `fields`), the submit control, or EmDash's own CommentForm (`emdash`).
 */
export type WpShellCommentHole =
	| { s: "heading" }
	| { s: "list" }
	| { s: "respond" }
	| { s: "count" }
	| { s: "items" }
	| { s: "cls" }
	| { s: "id" }
	| { s: "author" }
	| { s: "date" }
	| { s: "time" }
	| { s: "text" }
	| { s: "replies" }
	| { s: "form"; id?: string; class?: string }
	| { s: "/form" }
	| { s: "field"; field: WpShellCommentField }
	| {
			s: "control";
			id?: string;
			class?: string;
			rows?: number;
			cols?: number;
			size?: number;
			placeholder?: string;
	  }
	| { s: "label"; for?: string; class?: string }
	| { s: "/label" }
	| { s: "submit"; tag: "input" | "button"; id?: string; class?: string; label: string }
	| { s: "emdash" };
export type WpShellCommentPart = string | WpShellCommentHole;

/**
 * A post's comment area as the theme drew it (comments.php), with holes for
 * EmDash's comments: the count heading, the list in the theme's markup for
 * one comment, and the reply block with its form in the theme's markup for
 * each box. Filled from EmDash's own approved comments, posting to EmDash's
 * own comment API with EmDash's own fields and spam check.
 */
export interface WpShellCommentArea {
	parts: WpShellCommentPart[];
	/** The count heading, drawn at each count whose phrase the record knows: `%d` the count, `%t` the title. */
	heading?: { item: WpShellCommentPart[]; zero?: string; one?: string; many?: string };
	/** The list, one comment, its replies' list, the comment's own classes and how it prints its date and time. */
	list?: {
		item: WpShellCommentPart[];
		comment: WpShellCommentPart[];
		replies: WpShellCommentPart[];
		classes: string;
		date?: string;
		time?: string;
	};
	/** The reply block: its title, and the form's element, boxes and submit control as holes. */
	respond: WpShellCommentPart[];
	/** Each field's box and label, as the theme wraps it. */
	fields?: Record<WpShellCommentField, WpShellCommentPart[]>;
}

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
	/**
	 * Which pages the record's own layout draws print their title, where the
	 * site's pages differ (WordPress prints a page's title unless its theme's
	 * option, its template or its own setting says not to): the layout draws
	 * no title for a page `hidden` names, or for every page but the ones
	 * `shown` names. Pages are named by their slug, the home by its page's.
	 * A page drawn in a layout of its own keeps that layout's title.
	 */
	titles?: WpShellTitles;
	/** The site's forms in their plugin's markup: an EmDash form imported from one is drawn in it (renderWpShellForm). */
	forms?: WpShellForm[];
	/** The layout every single post is drawn in; without it, posts wear the record's own layout. */
	post?: WpShellPostLayout;
	/** The Archives widgets the layouts' `archives` slots draw. */
	archives?: WpShellArchives[];
	/** Where the site's date archives are, and what the theme calls them. */
	dates?: WpShellDates;
	/** The sign-ups the layouts' `subscribe` slots draw. */
	subscribe?: WpShellSubscribe[];
	/** Each page's own, where it is drawn in a layout it shares (WpShellPageOwn): without it, a page draws its layout's alone. */
	pageOwn?: WpShellPageOwn[];
}

/**
 * WordPress's Archives widget (or block), drawn with the months (or years)
 * EmDash's published posts fall in, each a link to its archive, so a post
 * published after the move is listed and a month's count is the site's own.
 *
 * `dropdown`: WordPress's list box, which a script sent to the month chosen.
 * The record runs no script, so the box is the summary of a `<details>`, drawn
 * as the list box was (the theme's rules for it, the builder's own control
 * look), and the months are links in the panel it opens. `list`: the widget's
 * list of links, as WordPress printed it.
 */
export interface WpShellArchives {
	as: "dropdown" | "list";
	type: "monthly" | "yearly";
	/** Whether each line says how many posts it has, as `(3)`. */
	count: boolean;
	/** The list box's id and classes (a dropdown), or the list's classes (a list). */
	id?: string;
	class?: string;
	/** The list box's first line, which it shows until a month is chosen ("Select Month"). */
	label?: string;
}

/** Where the site's date archives are, the time zone its posts' months are taken in, and the theme's headings for them. */
export interface WpShellDates {
	/** The path before the year (`/`, `/blog/`, `/date/`): WordPress's front of the permalink structure. */
	front: string;
	/** Plain permalinks: an archive is `/?m=YYYYMM`. */
	plain?: true;
	timeZone?: string;
	utcOffset?: number;
	/** The archive page's heading for a year, a month and a day, `%s` the archive's name ("Monthly Archive: %s"). */
	title?: { year?: string; month?: string; day?: string };
}

/**
 * A hole in a sign-up's templates. Its markup: EmDash's form element and its
 * end, where the form's fields go (drawn until the visitor has subscribed),
 * and where the count line goes. Its fields: a label and its end, the email
 * box, the submit control. The count line: its phrase.
 */
export type WpShellSubscribeHole =
	| { s: "form"; id?: string; class?: string }
	| { s: "/form" }
	| { s: "fields" }
	| { s: "count" }
	| { s: "label"; for?: string; class?: string }
	| { s: "/label" }
	| { s: "control"; id?: string; class?: string; placeholder?: string }
	| { s: "submit"; tag: "button" | "input"; id?: string; class?: string; label: string }
	| { s: "phrase" };
export type WpShellSubscribePart = string | WpShellSubscribeHole;

/**
 * A sign-up for new posts by email (Jetpack's Subscriptions widget) in the
 * plugin's markup, with holes for EmDash's own form: a visitor's address is
 * posted to the site's subscriptions plugin, and the count line says how many
 * others the site itself has, never the number WordPress.com had.
 */
export interface WpShellSubscribe {
	plugin: "jetpack";
	parts: WpShellSubscribePart[];
	fields: WpShellSubscribePart[];
	/** The line that says how many others subscribed, drawn for one or more: `%s` the count. */
	count?: { item: WpShellSubscribePart[]; one: string; many: string };
}

/** A page's own layout, for the EmDash page of its slug. */
export interface WpShellPageLayout extends WpShellLayout {
	slug: string;
	/**
	 * Other pages drawn in this layout, by their slugs: the pages of the site on
	 * the same page-builder template as the one it was cut from (a full-width
	 * or blank-canvas template), which wear none of the default template's
	 * wrapper. Each carries its own rules in `pageOwn`.
	 */
	also?: string[];
}

/**
 * What a page drawn in a layout it shares with other pages carries of its
 * own: its stylesheets (the rules its page builder writes for that page
 * alone, which no shared layout carries) and the body classes that name it
 * (`page-id-21`). Drawn for the page (or the home) of that slug, after its
 * layout's own.
 */
export interface WpShellPageOwn {
	slug: string;
	styles?: string[];
	body?: string;
}

/** The pages that print no title where the site prints it (`hidden`), or that print it where the site prints none (`shown`). */
export type WpShellTitles = { hidden: string[] } | { shown: string[] };

/** The most pages a record's `titles` names: one REST API answer of WordPress's pages is at most 100. */
const MAX_TITLED = 1000;
/** The most stylesheets one page's own adds to its layout's. */
const MAX_PAGE_STYLES = 8;

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
export type WpShellKind = "home" | "page" | "post" | "archive";

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
	...(s.post ? [s.post] : []),
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
	// A sign-up drawn whole: its fields and its count line in their holes (renderWpShellSubscribe).
	for (const x of s.subscribe ?? []) {
		const fill = (t: readonly WpShellSubscribePart[], holes: Record<string, string> = {}) =>
			t.map((y) => (typeof y === "string" ? y : (holes[y.s] ?? SUBSCRIBE_FILL[y.s]))).join("");
		out.push(
			fill(x.parts, {
				fields: fill(x.fields),
				count: x.count ? fill(x.count.item) : "",
			}),
		);
	}
	if (s.post) out.push(...postMarkupForCheck(s.post));
	return out;
}

/**
 * A post layout's holes filled for the check: its links and images with
 * values the tripwire reads as the site's, its text holes with markup that
 * only fits between tags, and its markup holes with the record's own
 * sub-templates, filled the same way.
 */
const POST_FILL: Record<WpShellPostHole, string> = {
	href: "#",
	adjHref: "#",
	"share-x": "#",
	"share-facebook": "#",
	"share-linkedin": "#",
	"share-email": "#",
	src: "/_emdash/api/media/file/a.png",
	avatar: "<b></b>",
	alt: "",
	date: "<b></b>",
	author: "<b></b>",
	title: "<b></b>",
	label: "<b></b>",
	count: "<b></b>",
	name: "<b></b>",
	adjTitle: "<b></b>",
	bio: "<b></b>",
	terms: "<b></b>",
	categories: "<b></b>",
	tags: "<b></b>",
	comments: "<b></b>",
	prev: "<b></b>",
	next: "<b></b>",
};

function postMarkupForCheck(post: WpShellPostLayout): string[] {
	const fill = (
		t: readonly WpShellPostPart[],
		holes: Partial<Record<WpShellPostHole, string>> = {},
	) => t.map((x) => (typeof x === "string" ? x : (holes[x.s] ?? POST_FILL[x.s]))).join("");
	const terms = (t: WpShellPostTerms | undefined) =>
		t ? fill(t.item, { terms: [fill(t.term), fill(t.term)].join(escapeHtml(t.sep)) }) : "";
	const markup = {
		categories: terms(post.terms?.category),
		tags: terms(post.terms?.tag),
		comments: post.comments ? fill(post.comments.item) : "",
	};
	const out = post.meta.map((m) => fill(m, markup));
	for (const t of [post.featured?.item, post.trailTerm, post.share, post.comments?.item])
		if (t) out.push(fill(t));
	out.push(markup.categories, markup.tags);
	if (post.author)
		out.push(
			fill(post.author.item, { avatar: post.author.avatar ? fill(post.author.avatar) : "" }),
		);
	if (post.author?.avatar) out.push(fill(post.author.avatar));
	if (post.adjacent)
		out.push(
			fill(post.adjacent.item, { prev: fill(post.adjacent.prev), next: fill(post.adjacent.next) }),
			fill(post.adjacent.prev),
			fill(post.adjacent.next),
		);
	if (post.commentArea) out.push(commentMarkupForCheck(post.commentArea));
	return out;
}

/** A comment area's holes filled for the check: each template filled with the ones it draws, text holes with markup that only fits between tags. */
const COMMENT_FILL: Record<WpShellCommentHole["s"], string> = {
	heading: "<b></b>",
	list: "<b></b>",
	respond: "<b></b>",
	count: "<b></b>",
	items: "<b></b>",
	cls: "",
	id: "x",
	author: "<b></b>",
	date: "<b></b>",
	time: "<b></b>",
	text: "<b></b>",
	replies: "<b></b>",
	form: "<div>",
	"/form": "</div>",
	field: "<b></b>",
	control: "<b></b>",
	label: "<b>",
	"/label": "</b>",
	submit: "<b></b>",
	emdash: "<b></b>",
};

/** The whole area filled for the check: every template drawn in its hole (the tripwire requires each hole the area's templates need). */
function commentMarkupForCheck(a: WpShellCommentArea): string {
	const fill = (t: readonly WpShellCommentPart[], holes: Partial<Record<string, string>> = {}) =>
		t.map((x) => (isText(x) ? x : (holes[x.s] ?? COMMENT_FILL[x.s]))).join("");
	const fields = a.fields;
	const respond = a.respond
		.map((x) =>
			isText(x) ? x : x.s === "field" && fields ? fill(fields[x.field]) : COMMENT_FILL[x.s],
		)
		.join("");
	const heading = a.heading ? fill(a.heading.item) : "";
	const comment = a.list ? fill(a.list.comment, { replies: fill(a.list.replies) }) : "";
	const list = a.list ? fill(a.list.item, { items: comment + comment }) : "";
	return fill(a.parts, { heading, list, respond });
}

/** Every template of a comment area. */
function commentTemplatesOf(a: WpShellCommentArea): WpShellCommentPart[][] {
	const { fields } = a;
	return [
		a.parts,
		a.respond,
		...(a.heading ? [a.heading.item] : []),
		...(a.list ? [a.list.item, a.list.comment, a.list.replies] : []),
		...(fields ? WP_SHELL_COMMENT_FIELDS.map((f) => fields[f]) : []),
	];
}

/** Every template of a post layout. */
function postTemplatesOf(post: WpShellPostLayout): WpShellPostPart[][] {
	return [
		...post.meta,
		...[post.terms?.category, post.terms?.tag].flatMap((t) => (t ? [t.item, t.term] : [])),
		...[
			post.comments?.item,
			post.featured?.item,
			post.trailTerm,
			post.share,
			post.author?.item,
			post.author?.avatar,
		].filter((t): t is WpShellPostPart[] => t !== undefined),
		...(post.adjacent ? [post.adjacent.item, post.adjacent.prev, post.adjacent.next] : []),
	];
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

const SUBSCRIBE_FILL: Record<WpShellSubscribeHole["s"], string> = {
	form: "<div>",
	"/form": "</div>",
	fields: "<b></b>",
	count: "<b></b>",
	label: "<b>",
	"/label": "</b>",
	control: "<b></b>",
	submit: "<b></b>",
	phrase: "<b></b>",
};

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

/** How many of each list the record's slots may name. */
interface SlotCounts {
	listings: number;
	archives: number;
	subscribe: number;
}

function checkPart(
	p: unknown,
	menus: number,
	counts: SlotCounts,
	post: WpShellPostLayout | null = null,
): string | null {
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
			return isIndex(p.listing, counts.listings) ? null : "a listing slot names no listing";
		case "archives":
			return isIndex(p.archives, counts.archives) ? null : "an archives slot names no archives";
		case "subscribe":
			return isIndex(p.subscribe, counts.subscribe) ? null : "a subscribe slot names no sign-up";
		// A post's slots are drawn only in the post layout, from its own templates.
		case "postMeta":
			return post && isIndex(p.meta, post.meta.length)
				? null
				: "a post meta slot names no meta of a post layout";
		case "featured":
		case "trailTerm":
		case "authorBio":
		case "adjacent": {
			const has =
				p.slot === "featured"
					? post?.featured
					: p.slot === "trailTerm"
						? post?.trailTerm
						: p.slot === "authorBio"
							? post?.author
							: post?.adjacent;
			return has ? null : `a ${String(p.slot)} slot outside a post layout that carries one`;
		}
		case "comments":
			return post && checkElement(p)
				? null
				: "a comments slot outside a post layout, or on an element this layout does not draw";
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
	for (const x of s.subscribe ?? [])
		for (const t of [x.parts, x.fields, ...(x.count ? [x.count.item] : [])])
			for (const y of t) if (typeof y === "string") out.push(y);
	if (s.post) {
		for (const t of postTemplatesOf(s.post))
			for (const x of t) if (typeof x === "string") out.push(x);
		if (s.post.commentArea)
			for (const t of commentTemplatesOf(s.post.commentArea))
				for (const x of t) if (typeof x === "string") out.push(x);
		for (const t of [s.post.terms?.category, s.post.terms?.tag]) if (t) out.push(t.sep);
	}
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

/** Why a record's `pageOwn` is not a list of pages' own stylesheets and body classes, each page once, or null. */
function checkPageOwn(v: unknown): string | null {
	if (!Array.isArray(v) || v.length > MAX_TITLED) return "not a list";
	const slugs = new Set<string>();
	for (const o of v) {
		if (!isObject(o) || !isText(o.slug) || !PAGE_SLUG.test(o.slug) || slugs.has(o.slug))
			return "an entry names no page";
		slugs.add(o.slug);
		if (o.styles === undefined && o.body === undefined) return `${o.slug} carries nothing`;
		if (
			o.styles !== undefined &&
			(!Array.isArray(o.styles) ||
				o.styles.length > MAX_PAGE_STYLES ||
				!o.styles.every((h) => typeof h === "string" && STYLE_HREF.test(h)))
		)
			return `a stylesheet of ${o.slug} is not one of the site's own files`;
		if (
			o.body !== undefined &&
			(typeof o.body !== "string" || !TOKENS.test(o.body) || o.body.length > SHORT_TEXT)
		)
			return `the body classes of ${o.slug} are not tokens`;
	}
	return null;
}

/** Whether `t` is a record's titles: one list, `hidden` or `shown`, of distinct page slugs. */
function checkTitles(t: unknown): t is WpShellTitles {
	if (!isObject(t) || Object.keys(t).length !== 1) return false;
	const list = "hidden" in t ? t.hidden : t.shown;
	return (
		Array.isArray(list) &&
		list.length <= MAX_TITLED &&
		list.every((s) => isText(s) && PAGE_SLUG.test(s)) &&
		new Set(list).size === list.length
	);
}

/** A line of text the layout escapes and draws: a list box's first line, a box's placeholder, a button's words. */
const SHORT_TEXT = 200;
const isShortText = (v: unknown): v is string => isText(v) && v.length <= SHORT_TEXT;
const optionalShortText = (v: unknown) => v === undefined || isShortText(v);
/** A phrase with one `%s` where a count or a name goes, and nothing that could open a tag. */
const PHRASE = /^[^<>%]{0,200}%s[^<>%]{0,200}$/;

/** Why an Archives widget is not one this layout draws, or null. */
function checkArchives(a: unknown): string | null {
	if (!isObject(a)) return "an archives widget is not an object";
	if (a.as !== "dropdown" && a.as !== "list")
		return "an archives widget is neither a list box nor a list";
	if (a.type !== "monthly" && a.type !== "yearly")
		return "an archives widget lists neither months nor years";
	if (typeof a.count !== "boolean") return "an archives widget does not say whether it counts";
	if (!optionalToken(a.id) || !optionalToken(a.class))
		return "an archives widget's id or classes are not tokens";
	if (!optionalShortText(a.label)) return "an archives widget's first line is not one";
	return null;
}

/** Why the record's date archives are not ones this layout draws, or null. */
function checkDates(d: unknown): string | null {
	if (!isObject(d)) return "the date archives are not an object";
	if (!isText(d.front) || !DATE_FRONT.test(d.front))
		return "the date archives' front is not a path";
	if (d.plain !== undefined && d.plain !== true) return "the date archives' plain flag is not one";
	if (d.timeZone !== undefined && (!isText(d.timeZone) || !TIME_ZONE.test(d.timeZone)))
		return "the date archives' time zone is not one";
	if (
		d.utcOffset !== undefined &&
		(typeof d.utcOffset !== "number" ||
			!Number.isInteger(d.utcOffset) ||
			Math.abs(d.utcOffset) > 840)
	)
		return "the date archives' offset from UTC is not one";
	const { title } = d;
	if (
		title !== undefined &&
		(!isObject(title) ||
			Object.keys(title).some((k) => !["year", "month", "day"].includes(k)) ||
			Object.values(title).some((v) => !isText(v) || !PHRASE.test(v)))
	)
		return "the date archives' headings are not phrases";
	return null;
}

const SUBSCRIBE_HOLES = new Set(["form", "/form", "fields", "count"]);
const SUBSCRIBE_FIELD_HOLES = new Set(["label", "/label", "control", "submit"]);
const SUBSCRIBE_COUNT_HOLES = new Set(["phrase"]);

/**
 * How many of each hole a sign-up's template has, or null when it is not one
 * this layout fills: a hole of another kind, attributes that are not tokens,
 * labels that do not nest, or a hole inside a tag.
 */
function subscribeHoles(t: unknown, allowed: ReadonlySet<string>): Record<string, number> | null {
	if (!Array.isArray(t)) return null;
	const count: Record<string, number> = {};
	let depth = 0;
	for (const [i, x] of t.entries()) {
		if (isText(x)) continue;
		if (!isObject(x) || !isText(x.s) || !allowed.has(x.s)) return null;
		count[x.s] = (count[x.s] ?? 0) + 1;
		if (!optionalToken(x.id) || !optionalToken(x.class) || !optionalToken(x.for)) return null;
		if (!optionalShortText(x.placeholder)) return null;
		if (x.s === "submit" && ((x.tag !== "button" && x.tag !== "input") || !isShortText(x.label)))
			return null;
		if (x.s === "label") depth++;
		if (x.s === "/label" && --depth < 0) return null;
		const before = t
			.slice(0, i)
			.map((y) => (isText(y) ? y : "X"))
			.join("");
		if (before.lastIndexOf("<") > before.lastIndexOf(">")) return null;
	}
	return depth === 0 ? count : null;
}

/** Why a sign-up is not one this layout draws, or null. */
function checkSubscribe(x: unknown): string | null {
	if (!isObject(x)) return "a sign-up is not an object";
	if (x.plugin !== "jetpack") return "a sign-up's plugin is not one this layout draws";
	const parts = subscribeHoles(x.parts, SUBSCRIBE_HOLES);
	const fields = subscribeHoles(x.fields, SUBSCRIBE_FIELD_HOLES);
	if (!parts || !fields) return "a sign-up's templates are malformed";
	if (parts.form !== 1 || parts["/form"] !== 1 || parts.fields !== 1)
		return "a sign-up needs one form element and one place for its fields";
	// The fields go inside the form.
	const holes = Array.isArray(x.parts) ? x.parts : [];
	const at = (s: string) => holes.findIndex((p: unknown) => isObject(p) && p.s === s);
	if (!(at("form") < at("fields") && at("fields") < at("/form")))
		return "a sign-up's fields are not inside its form";
	if (fields.control !== 1 || fields.submit !== 1)
		return "a sign-up needs one email box and one submit control";
	const { count } = x;
	if (count === undefined) return parts.count ? "a sign-up's count line has no template" : null;
	if (parts.count !== 1) return "a sign-up's count line is not drawn once";
	if (
		!isObject(count) ||
		subscribeHoles(count.item, SUBSCRIBE_COUNT_HOLES)?.phrase !== 1 ||
		!isText(count.one) ||
		!PHRASE.test(count.one) ||
		!isText(count.many) ||
		!PHRASE.test(count.many)
	)
		return "a sign-up's count line is malformed";
	return null;
}

const countSlot = (parts: unknown[], slot: string) =>
	parts.filter((p) => isObject(p) && p.slot === slot).length;

/** Why a layout's body, stylesheets or parts are not ones this template draws, or null. */
function checkLayout(
	l: Record<string, unknown>,
	menus: number,
	counts: SlotCounts,
	post: WpShellPostLayout | null = null,
): string | null {
	const { body, styles, parts } = l;
	if (!isObject(body) || typeof body.class !== "string" || !TOKENS.test(body.class)) {
		return "body class is not tokens";
	}
	if (!Array.isArray(styles) || !styles.every((h) => typeof h === "string" && STYLE_HREF.test(h))) {
		return "a stylesheet is not one of the site's own files";
	}
	if (!Array.isArray(parts)) return "no parts";
	for (const p of parts) {
		const why = checkPart(p, menus, counts, post);
		if (why) return why;
	}
	if (countSlot(parts, "title") !== 1 || countSlot(parts, "content") !== 1) {
		return "the record needs exactly one title and one content slot";
	}
	if (countSlot(parts, "comments") > 1) return "a post layout has more than one comments slot";
	return null;
}

const POST_META_HOLES = new Set([
	"href",
	"date",
	"author",
	"title",
	"categories",
	"tags",
	"comments",
]);
const SHARE_HOLES = ["share-x", "share-facebook", "share-linkedin", "share-email"] as const;
/** What each attribute hole of a post template is filled inside, and only there. */
const POST_IN_ATTRIBUTE: Record<string, string> = {
	href: 'href="',
	adjHref: 'href="',
	src: 'src="',
	alt: 'alt="',
	...Object.fromEntries(SHARE_HOLES.map((h) => [h, 'href="'])),
};
const MAX_POST_META = 20;
const PHRASE_PERCENT = /%d/g;

/** A post template: markup and holes of `allowed` kinds, each attribute hole inside its own attribute. */
function checkPostTemplate(t: unknown, allowed: ReadonlySet<string>): boolean {
	return (
		Array.isArray(t) &&
		t.every((x, i) => {
			if (typeof x === "string") return true;
			if (!isObject(x) || typeof x.s !== "string" || !allowed.has(x.s)) return false;
			const attribute = POST_IN_ATTRIBUTE[x.s];
			const before = t[i - 1];
			return attribute === undefined || (typeof before === "string" && before.endsWith(attribute));
		})
	);
}

/** A comment count's phrase: short, no markup, at most one `%d`. */
const checkPhrase = (v: unknown) =>
	v === undefined ||
	(isText(v) &&
		v.length <= 80 &&
		!v.includes("<") &&
		!v.includes(">") &&
		(v.match(PHRASE_PERCENT)?.length ?? 0) <= 1);

function checkTerms(t: unknown): boolean {
	return (
		t === undefined ||
		(isObject(t) &&
			checkPostTemplate(t.item, new Set(["terms"])) &&
			checkPostTemplate(t.term, new Set(["href", "label"])) &&
			isText(t.sep) &&
			t.sep.length <= 20 &&
			!t.sep.includes("<") &&
			!t.sep.includes(">"))
	);
}

/** How a comment's time is printed, in PHP date() letters (g G h H i a A). */
const TIME_FORMAT = /^[gGhHiaA :.]{1,12}$/;
/** An id or `for` a comment hole writes: the theme's own token, never one EmDash's toolbar looks itself up by. */
const COMMENT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const optionalId = (v: unknown) =>
	v === undefined || (isText(v) && COMMENT_ID.test(v) && !EMDASH_ID.test(v));
/** Words a hole writes as text (a submit label, a placeholder): short, no markup. */
const checkWords = (v: unknown, max: number) =>
	isText(v) && v.length <= max && !v.includes("<") && !v.includes(">");
const optionalSize = (v: unknown) => v === undefined || (isIndex(v, 1000) && v !== 0);

/** The holes each comment area template may hold. */
const COMMENT_TEMPLATE_HOLES = {
	parts: new Set(["heading", "list", "respond"]),
	heading: new Set(["count"]),
	list: new Set(["items"]),
	comment: new Set(["cls", "id", "author", "date", "time", "text", "replies"]),
	respond: new Set(["form", "/form", "field", "label", "/label", "submit", "emdash"]),
	field: new Set(["control", "label", "/label"]),
} as const;

/**
 * A comment area template: markup and holes of `allowed` kinds, each hole's
 * own values tokens or short words, `cls` inside a class attribute, `id`
 * inside an id or a `#` link, labels closed. That every other hole is between
 * tags, the filled markup's check reads (its fill is markup, COMMENT_FILL).
 */
function checkCommentTemplate(t: unknown, allowed: ReadonlySet<string>): t is WpShellCommentPart[] {
	if (!Array.isArray(t)) return false;
	let depth = 0;
	const ok = t.every((x, i) => {
		if (isText(x)) return true;
		if (!isObject(x) || !isText(x.s) || !allowed.has(x.s)) return false;
		if (!optionalToken(x.class) || !optionalId(x.id) || !optionalId(x.for)) return false;
		if (x.s === "field" && !(WP_SHELL_COMMENT_FIELDS as readonly unknown[]).includes(x.field))
			return false;
		if (
			x.s === "control" &&
			(!optionalSize(x.rows) ||
				!optionalSize(x.cols) ||
				!optionalSize(x.size) ||
				(x.placeholder !== undefined && !checkWords(x.placeholder, 200)))
		)
			return false;
		if (
			x.s === "submit" &&
			((x.tag !== "input" && x.tag !== "button") || !checkWords(x.label, 80) || x.label === "")
		)
			return false;
		if (x.s === "label") depth++;
		if (x.s === "/label" && --depth < 0) return false;
		const before = t
			.slice(0, i)
			.map((y) => (isText(y) ? y : "X"))
			.join("");
		if (x.s === "cls") return before.endsWith('class="');
		return x.s !== "id" || COMMENT_ID_AT.test(before);
	});
	return ok && depth === 0;
}
/** Where an `id` hole is written: at the end of an id's value, or of a link to a place on the page. */
const COMMENT_ID_AT = /(?:id="|href="#)[A-Za-z0-9_-]*$/;

const holesIn = (t: readonly WpShellCommentPart[], s: string) =>
	t.filter((x) => !isText(x) && x.s === s).length;
const phraseTitles = (v: unknown) => !isText(v) || v.split("%t").length <= 2;

/** Why a comment area is not one this layout fills, or null. */
function checkCommentArea(a: unknown): string | null {
	if (!isObject(a)) return "not an object";
	const { parts, heading, list, respond, fields } = a;
	const H = COMMENT_TEMPLATE_HOLES;
	if (!checkCommentTemplate(parts, H.parts)) return "its parts are malformed";
	if (
		holesIn(parts, "respond") !== 1 ||
		holesIn(parts, "list") !== 1 ||
		holesIn(parts, "heading") !== (heading === undefined ? 0 : 1)
	)
		return "its parts need one reply block, one list and a heading only where it has one";
	if (
		heading !== undefined &&
		(!isObject(heading) ||
			!checkCommentTemplate(heading.item, H.heading) ||
			holesIn(heading.item, "count") !== 1 ||
			![heading.zero, heading.one, heading.many].every((p) => checkPhrase(p) && phraseTitles(p)))
	)
		return "its count heading is malformed";
	if (list !== undefined) {
		if (
			!isObject(list) ||
			!checkCommentTemplate(list.item, H.list) ||
			!checkCommentTemplate(list.replies, H.list) ||
			holesIn(list.item, "items") !== 1 ||
			holesIn(list.replies, "items") !== 1 ||
			!checkCommentTemplate(list.comment, H.comment) ||
			!isText(list.classes) ||
			!TOKENS.test(list.classes) ||
			(list.date !== undefined && (!isText(list.date) || !DATE_FORMAT.test(list.date))) ||
			(list.time !== undefined && (!isText(list.time) || !TIME_FORMAT.test(list.time)))
		)
			return "its list is malformed";
		const c = list.comment;
		if (
			holesIn(c, "cls") !== 1 ||
			holesIn(c, "author") !== 1 ||
			holesIn(c, "text") !== 1 ||
			holesIn(c, "replies") !== 1 ||
			holesIn(c, "date") > (list.date === undefined ? 0 : 1) ||
			holesIn(c, "time") > (list.time === undefined ? 0 : 1)
		)
			return "its comment is malformed";
	}
	if (!checkCommentTemplate(respond, H.respond)) return "its reply block is malformed";
	if (fields === undefined) {
		if (
			holesIn(respond, "emdash") !== 1 ||
			["form", "/form", "field", "submit"].some((h) => holesIn(respond, h) > 0)
		)
			return "its reply block has no form of its own and not EmDash's once";
		return null;
	}
	if (!isObject(fields) || Object.keys(fields).length !== WP_SHELL_COMMENT_FIELDS.length)
		return "its fields are malformed";
	for (const f of WP_SHELL_COMMENT_FIELDS) {
		const t = fields[f];
		if (!checkCommentTemplate(t, H.field) || holesIn(t, "control") !== 1)
			return `its ${f} box is malformed`;
	}
	// The form's element around every box and the submit control, once each.
	const at = (pred: (x: WpShellCommentHole) => boolean) =>
		respond.flatMap((x, i) => (!isText(x) && pred(x) ? [i] : []));
	const [open] = at((x) => x.s === "form");
	const [close] = at((x) => x.s === "/form");
	const inside = at((x) => x.s === "field" || x.s === "submit");
	if (
		holesIn(respond, "form") !== 1 ||
		holesIn(respond, "/form") !== 1 ||
		holesIn(respond, "submit") !== 1 ||
		holesIn(respond, "emdash") !== 0 ||
		!WP_SHELL_COMMENT_FIELDS.every(
			(f) => at((x) => x.s === "field" && x.field === f).length === 1,
		) ||
		open === undefined ||
		close === undefined ||
		!inside.every((i) => i > open && i < close)
	)
		return "its form needs one element around each box and one submit control";
	return null;
}

/** Why a post layout's own templates are not ones this layout fills, or null (its layout is checkLayout's). */
function checkPost(v: Record<string, unknown>): string | null {
	const {
		date,
		timeZone,
		utcOffset,
		meta,
		terms,
		comments,
		featured,
		trailTerm,
		share,
		author,
		adjacent,
		commentArea,
	} = v;
	if (date !== undefined && (typeof date !== "string" || !DATE_FORMAT.test(date)))
		return "the post layout's date format is not one";
	if (timeZone !== undefined && (typeof timeZone !== "string" || !TIME_ZONE.test(timeZone)))
		return "the post layout's time zone is not one";
	if (
		utcOffset !== undefined &&
		(typeof utcOffset !== "number" || !Number.isInteger(utcOffset) || Math.abs(utcOffset) > 840)
	)
		return "the post layout's offset from UTC is not one";
	if (
		!Array.isArray(meta) ||
		meta.length > MAX_POST_META ||
		!meta.every((m) => checkPostTemplate(m, POST_META_HOLES))
	)
		return "a post meta template is malformed";
	if (
		terms !== undefined &&
		(!isObject(terms) || !checkTerms(terms.category) || !checkTerms(terms.tag))
	)
		return "the post layout's terms are malformed";
	if (
		comments !== undefined &&
		(!isObject(comments) ||
			!checkPostTemplate(comments.item, new Set(["href", "count", "title"])) ||
			!checkPhrase(comments.zero) ||
			!checkPhrase(comments.one) ||
			!checkPhrase(comments.many))
	)
		return "the post layout's comment count is malformed";
	if (
		featured !== undefined &&
		(!isObject(featured) ||
			!checkPostTemplate(featured.item, new Set(["src", "alt"])) ||
			!isIndex(featured.minWidth, 10_000))
	)
		return "the post layout's featured image is malformed";
	if (trailTerm !== undefined && !checkPostTemplate(trailTerm, new Set(["href", "label"])))
		return "the post layout's trail term is malformed";
	if (share !== undefined && !checkPostTemplate(share, new Set(SHARE_HOLES)))
		return "the post layout's share links are malformed";
	if (
		author !== undefined &&
		(!isObject(author) ||
			!checkPostTemplate(author.item, new Set(["name", "bio", "avatar"])) ||
			(author.avatar !== undefined && !checkPostTemplate(author.avatar, new Set(["src"]))))
	)
		return "the post layout's author bio is malformed";
	if (
		adjacent !== undefined &&
		(!isObject(adjacent) ||
			!checkPostTemplate(adjacent.item, new Set(["prev", "next"])) ||
			!checkPostTemplate(adjacent.prev, new Set(["adjHref", "adjTitle"])) ||
			!checkPostTemplate(adjacent.next, new Set(["adjHref", "adjTitle"])))
	)
		return "the post layout's adjacent posts are malformed";
	if (commentArea !== undefined) {
		const why = checkCommentArea(commentArea);
		if (why) return `the post layout's comment area: ${why}`;
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
	const { archives = [], subscribe = [] } = value;
	if (!Array.isArray(archives)) return "the archives are not a list";
	for (const a of archives) {
		const why = checkArchives(a);
		if (why) return why;
	}
	if (value.dates !== undefined) {
		const why = checkDates(value.dates);
		if (why) return why;
	}
	if (!Array.isArray(subscribe)) return "the sign-ups are not a list";
	for (const x of subscribe) {
		const why = checkSubscribe(x);
		if (why) return why;
	}
	const counts: SlotCounts = {
		listings: listings.length,
		archives: archives.length,
		subscribe: subscribe.length,
	};
	const layout = checkLayout({ body, styles, parts }, menus.length, counts);
	if (layout) return layout;
	if (value.home !== undefined) {
		const why = isObject(value.home)
			? checkLayout(value.home, menus.length, counts)
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
		// The other pages drawn in it: each a page of its own slug, drawn in one layout only.
		if (pg.also !== undefined) {
			if (!Array.isArray(pg.also) || pg.also.length > MAX_TITLED)
				return `the ${pg.slug} page layout: its other pages are not a list`;
			for (const slug of pg.also) {
				if (!isText(slug) || !PAGE_SLUG.test(slug) || slugs.has(slug))
					return `the ${pg.slug} page layout: another page it draws names no page of its own`;
				slugs.add(slug);
			}
		}
		const why = checkLayout(pg, menus.length, counts);
		if (why) return `the ${pg.slug} page layout: ${why}`;
	}
	if (value.pageOwn !== undefined) {
		const why = checkPageOwn(value.pageOwn);
		if (why) return `a page's own: ${why}`;
	}
	if (value.titles !== undefined && !checkTitles(value.titles)) return "the titles name no pages";
	if (!Array.isArray(forms)) return "the forms are not a list";
	for (const f of forms) {
		const why = checkForm(f);
		if (why) return why;
	}
	if (value.post !== undefined) {
		if (!isObject(value.post)) return "the post layout: not an object";
		const own = checkPost(value.post);
		if (own) return `the post layout: ${own}`;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- checkPost checked the post's own fields
		const post = value.post as unknown as WpShellPostLayout;
		const why = checkLayout(value.post, menus.length, counts, post);
		if (why) return `the post layout: ${why}`;
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

const ordinal = (d: number) =>
	d % 10 === 1 && d !== 11
		? "st"
		: d % 10 === 2 && d !== 12
			? "nd"
			: d % 10 === 3 && d !== 13
				? "rd"
				: "th";

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

/** The hour and minute `date` falls on in the site's time zone (UTC when it has none, or an unknown one). */
function clockIn(
	date: Date,
	zone: { timeZone?: string; utcOffset?: number },
): { h: number; i: number } {
	if (zone.timeZone) {
		try {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: zone.timeZone,
				hour: "numeric",
				minute: "numeric",
				hourCycle: "h23",
			}).formatToParts(date);
			const part = (type: string) => Number(parts.find((x) => x.type === type)?.value);
			return { h: part("hour"), i: part("minute") };
		} catch {
			// An unknown zone: UTC, below.
		}
	}
	const t = new Date(date.getTime() + (zone.utcOffset ?? 0) * 60_000);
	return { h: t.getUTCHours(), i: t.getUTCMinutes() };
}

/** A time as PHP's date() prints it with `format`'s letters (g G h H i a A); anything else is literal. */
export function formatWpTime(
	date: Date,
	format: string,
	zone: { timeZone?: string; utcOffset?: number } = {},
): string {
	const { h, i } = clockIn(date, zone);
	const twelve = h % 12 === 0 ? 12 : h % 12;
	const letters: Record<string, string> = {
		g: String(twelve),
		G: String(h),
		h: String(twelve).padStart(2, "0"),
		H: String(h).padStart(2, "0"),
		i: String(i).padStart(2, "0"),
		a: h < 12 ? "am" : "pm",
		A: h < 12 ? "AM" : "PM",
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

// --- date archives -------------------------------------------------------------

/** Where a site's date archives are and the time zone its months are taken in: the record's, else the site's setting. */
export interface WpShellDateSite {
	paths: WpDatePaths;
	zone: WpZone;
	titles: NonNullable<WpShellDates["title"]>;
}

/** An IANA zone name EmDash's timezone setting may hold. */
const ZONE_NAME = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

export function wpShellDateSite(
	shell: Pick<WpShell, "dates"> | null,
	timezone?: string | null,
): WpShellDateSite {
	const d = shell?.dates;
	const zone: WpZone = d?.timeZone
		? { timeZone: d.timeZone }
		: d?.utcOffset !== undefined
			? { utcOffset: d.utcOffset }
			: timezone && ZONE_NAME.test(timezone)
				? { timeZone: timezone }
				: {};
	return {
		paths: d ? { front: d.front, ...(d.plain ? { plain: true } : {}) } : { front: "/" },
		zone,
		titles: d?.title ?? {},
	};
}

/**
 * Arial's advance widths in thousandths of an em, for the printable ASCII
 * characters (Liberation Sans shares them): how wide Chromium draws a list
 * box, as wide as its longest line (Embark's builder measures the captured
 * box the same way). Any other character is taken as a digit's width.
 */
const ARIAL_WIDTHS = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
	556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
	611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
	667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
	222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** A line of a list box, in Chromium's 13.333px control font, in pixels. */
const listTextWidth = (text: string) =>
	(Array.from(
		text,
		(c) => ARIAL_WIDTHS[c.charCodeAt(0) - 32] ?? (c === "\u00a0" ? 278 : 556),
	).reduce((n, w) => n + w, 0) *
		13.333) /
	1000;
/** What a list box draws beside its longest line: its border, its padding and its arrow (measured on Chromium). */
const LIST_CHROME_PX = 34;

/**
 * An Archives widget with the months (or years) the site's published posts
 * fall in, newest first, each a link to its archive. A list box is a
 * `<details>`: its summary is the box as the theme drew it (showing its first
 * line, as wide as its longest), and it opens on the months as links, in
 * the order and words WordPress's list box had them.
 */
export function renderArchives(
	a: WpShellArchives,
	dates: readonly Date[] | null,
	site: Pick<WpShellDateSite, "paths" | "zone">,
): string {
	const groups = archiveGroups(dates ?? [], a.type, site.zone);
	const href = (g: { y: number; m?: number }) =>
		escapeAttr(datePath({ y: g.y, ...(g.m ? { m: g.m } : {}), page: 1 }, site.paths));
	if (a.as === "list") {
		const items = groups.map(
			(g) =>
				`<li><a href="${href(g)}">${escapeHtml(archiveLabel(g))}</a>${a.count ? `&nbsp;(${g.count})` : ""}</li>`,
		);
		return `<ul${a.class ? ` class="${escapeAttr(a.class)}"` : ""}>${items.join("\n")}</ul>`;
	}
	// WordPress's option: ` July 2023 &nbsp;(1)`, which a list box draws as `July 2023 \u00a0(1)`.
	const lines = groups.map((g) => `${archiveLabel(g)}${a.count ? ` \u00a0(${g.count})` : ""}`);
	const label = a.label ?? "";
	const width = Math.ceil(Math.max(0, ...[label, ...lines].map(listTextWidth)) + LIST_CHROME_PX);
	const cls = [...(a.class ? [a.class] : []), "wp-shell-field", "wp-shell-select"].join(" ");
	const items = groups.map(
		(g, i) => `<li><a href="${href(g)}">${escapeHtml(lines[i] ?? "")}</a></li>`,
	);
	return (
		`<details class="wp-shell-archives"><summary class="wp-shell-archives-summary">` +
		`<span style="--wp-shell-select-width:${width}px;"${a.id ? ` id="${escapeAttr(a.id)}"` : ""} class="${escapeAttr(cls)}">${escapeHtml(label)}</span>` +
		`</summary><ul class="wp-shell-archives-list">${items.join("")}</ul></details>`
	);
}

/** WordPress's default excerpt: 55 words, and ` […]` after one it cut. */
const ARCHIVE_EXCERPT: WpShellListing["excerpt"] = { words: 55, more: " [\u2026]" };

/**
 * An archive's posts, in the markup WordPress's classic themes print an entry
 * of a list in (Underscores' content.php, which most classic themes start
 * from): its title as a link, its date, and its excerpt. The theme's own
 * archive template is not in the record; its rules for these classes are.
 */
export function renderArchivePosts(
	posts: readonly WpShellPost[],
	site: Pick<WpShellDateSite, "zone">,
	dateFormat = "F j, Y",
): string {
	return posts
		.map((post) => {
			const href = escapeAttr(safeHref(post.url));
			const date = post.date
				? `<div class="entry-meta"><span class="posted-on"><a href="${href}" rel="bookmark"><time class="entry-date published" datetime="${escapeAttr(post.date.toISOString())}">${escapeHtml(formatWpDate(post.date, dateFormat, site.zone))}</time></a></span></div>`
				: "";
			const excerpt = listingExcerpt(post, ARCHIVE_EXCERPT)
				.map((p) => `<p>${escapeHtml(p)}</p>`)
				.join("");
			return (
				`<article class="post type-post status-publish format-standard hentry">` +
				`<header class="entry-header"><h2 class="entry-title"><a href="${href}" rel="bookmark">${escapeHtml(post.title)}</a></h2>${date}</header>` +
				(excerpt ? `<div class="entry-summary">${excerpt}</div>` : "") +
				`</article>`
			);
		})
		.join("");
}

/** The links to an archive's other pages, in WordPress's own markup (the_posts_navigation). */
export function renderArchiveNav(
	a: WpDateArchive,
	older: boolean,
	site: Pick<WpShellDateSite, "paths">,
): string {
	const newer = a.page > 1;
	if (!older && !newer) return "";
	const link = (page: number, words: string) =>
		`<a href="${escapeAttr(datePath({ ...a, page }, site.paths))}">${words}</a>`;
	return (
		`<nav class="navigation posts-navigation" aria-label="Posts"><h2 class="screen-reader-text">Posts navigation</h2><div class="nav-links">` +
		(older ? `<div class="nav-previous">${link(a.page + 1, "Older posts")}</div>` : "") +
		(newer ? `<div class="nav-next">${link(a.page - 1, "Newer posts")}</div>` : "") +
		`</div></nav>`
	);
}

// --- a sign-up ---------------------------------------------------------------

/** What the layout knows for a sign-up (renderWpShellSubscribe). */
export interface WpShellSubscribeFill {
	/** Where the form posts: the subscriptions plugin's route. */
	action: string;
	/** The page drawn, which the plugin sends the visitor back to. */
	source: string;
	/** What the plugin said the visitor's last try did (`?subscribe=`), or null. */
	status: string | null;
	/** How many confirmed subscribers the site has; null when it cannot say. */
	count: number | null;
}

/**
 * What a sign-up says after a try, by the plugin's status. Jetpack's own
 * words where they are true of this site; where the site cannot send email
 * yet, it says so rather than that an email was sent. `done`: the visitor is
 * signed up (or confirmed), and the fields are not drawn again, as Jetpack
 * draws none after a success.
 */
export const WP_SHELL_SUBSCRIBE_MESSAGES: Record<
	string,
	{ ok: boolean; done?: true; text: string }
> = {
	sent: {
		ok: true,
		done: true,
		text: "Success! An email was just sent to confirm your subscription. Please find the email now and click 'Confirm' to start subscribing.",
	},
	saved: {
		ok: true,
		done: true,
		text: "Thank you! Your subscription is saved. This site cannot send email yet, so no confirmation email was sent. It will send you one when it can, and new posts start once you confirm.",
	},
	queued: {
		ok: true,
		done: true,
		text: "Thank you! Your subscription is saved. The confirmation email could not be sent just now: the site will try again in a few minutes, and new posts start once you confirm.",
	},
	pending: {
		ok: false,
		text: "It seems you already tried to subscribe with this email, but have not confirmed from the email link we sent. Please check your email inbox to confirm.",
	},
	pending_saved: {
		ok: false,
		text: "You already asked to subscribe with this email. This site cannot send email yet: it will send you a confirmation email when it can.",
	},
	already: {
		ok: false,
		text: "You have already subscribed to this site. Please check your email inbox.",
	},
	invalid_email: { ok: false, text: "Oops! The email you used is invalid. Please try again." },
	error: { ok: false, text: "Oops! There was an error when subscribing. Please try again." },
	confirmed: {
		ok: true,
		done: true,
		text: "Your subscription is confirmed. Each new post will be emailed to you.",
	},
	unsubscribed: { ok: true, text: "You are unsubscribed. No more posts will be emailed to you." },
	invalid_link: { ok: false, text: "This link is not valid, or it was already used." },
};

/** A number to one decimal place, with none when it is whole: PHP's floatval(number_format($n, 1)). */
const tenth = (x: number) => String(Math.round(x * 10) / 10);

/** A count as Jetpack's line prints it: `23`, `1,234`, `12.3K`, `1.5M` (Jetpack_Memberships::get_join_others_text). */
function subscriberCount(n: number): string {
	if (n >= 1_000_000) return `${tenth(n / 1_000_000)}M`;
	if (n >= 10_000) return `${tenth(n / 1000)}K`;
	return n.toLocaleString("en-US");
}

/**
 * A sign-up in its plugin's markup, around EmDash's own form: it posts the
 * visitor's address to the site's subscriptions plugin, which sends them
 * back to this page with what it did (`?subscribe=`), said where Jetpack
 * says it, before the form. A hidden box a person never fills (a honeypot)
 * rides with it. The count line says how many confirmed subscribers the site
 * has, and is drawn for one or more, as Jetpack draws it.
 */
export function renderWpShellSubscribe(x: WpShellSubscribe, fill: WpShellSubscribeFill): string {
	const said = fill.status ? WP_SHELL_SUBSCRIBE_MESSAGES[fill.status] : undefined;
	const message = !said
		? ""
		: said.ok
			? `<div class="success"><p>${escapeHtml(said.text)}</p></div>`
			: `<p class="error">${escapeHtml(said.text)}</p>`;
	let fragment = "";
	const field = (h: WpShellSubscribeHole): string => {
		switch (h.s) {
			case "label":
				return `<label${attr("for", h.for)}${attr("class", h.class)}>`;
			case "/label":
				return "</label>";
			case "control":
				return `<input type="email" name="email" autocomplete="email" required${attr("id", h.id)}${attr("class", h.class)}${attr("placeholder", h.placeholder)}>`;
			case "submit":
				return h.tag === "input"
					? `<input type="submit"${attr("id", h.id)}${attr("class", h.class)} value="${escapeAttr(h.label)}">`
					: `<button type="submit"${attr("id", h.id)}${attr("class", h.class)}>${escapeHtml(h.label)}</button>`;
			default:
				return "";
		}
	};
	const count = (): string => {
		if (!x.count || fill.count === null || fill.count < 1) return "";
		const phrase = (fill.count === 1 ? x.count.one : x.count.many).replace(
			"%s",
			subscriberCount(fill.count),
		);
		return x.count.item
			.map((y) => (typeof y === "string" ? y : y.s === "phrase" ? escapeHtml(phrase) : ""))
			.join("");
	};
	const body = x.parts
		.map((y) => {
			if (typeof y === "string") return y;
			switch (y.s) {
				case "form":
					fragment = y.id ?? "";
					return (
						`<form method="post" action="${escapeAttr(fill.action)}" accept-charset="utf-8"${attr("id", y.id)}${attr("class", y.class)}>` +
						`<input type="hidden" name="source" value="${escapeAttr(fill.source)}">` +
						(fragment
							? `<input type="hidden" name="fragment" value="${escapeAttr(fragment)}">`
							: "") +
						`<p aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;"><input type="text" name="website" value="" tabindex="-1" autocomplete="off"></p>`
					);
				case "/form":
					return "</form>";
				case "fields":
					return said?.done
						? ""
						: x.fields.map((f) => (typeof f === "string" ? f : field(f))).join("");
				case "count":
					return count();
				default:
					return "";
			}
		})
		.join("");
	return message + body;
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
		const found = matched.filter((f) => f !== null);
		if (found.length === matched.length) return { form, fields: found };
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

// --- a post's comments, in the theme's comment area -------------------------------

/** An approved comment, as EmDash's getComments() gives it (its PublicComment). */
export interface WpShellComment {
	id: string;
	authorName: string;
	body: string;
	createdAt: string;
	replies?: readonly WpShellComment[];
}

/**
 * What a comment area draws: markup, or one of EmDash's own components where
 * the record has none of the theme's (its list of comments, its form).
 */
export type WpShellCommentsPiece = { html: string } | { emdash: "list" | "form" };

/** What EmDash's comment form says of the signed-in user it pre-fills (its locals.user). */
export interface WpShellCommentUser {
	name?: string | null;
	email?: string | null;
}

/** EmDash's comment form's honeypot and status line, as its CommentForm draws them. */
const COMMENT_HONEYPOT =
	'<div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;"><label>Don\'t fill this out<input type="text" name="website_url" tabindex="-1" autocomplete="off"></label></div>';
const COMMENT_STATUS =
	'<div class="ec-comment-form-status" role="status" aria-live="polite"></div>';
/** A link in a comment's words, as EmDash's Comments links one. */
const COMMENT_URL = /https?:\/\/[^\s<>"')\]]+/g;
const COMMENT_PARAGRAPH = /\n\s*\n/;
const COMMENT_LINE = /\n/g;

/** A comment's words as WordPress prints them: a paragraph for each blank-line run, a line break for each line, links as EmDash's Comments links them. */
function commentText(body: string): string {
	return body
		.split(COMMENT_PARAGRAPH)
		.map((p) => p.trim())
		.filter(Boolean)
		.map(
			(p) =>
				`<p>${escapeHtml(p)
					.replace(
						COMMENT_URL,
						(url) => `<a href="${url}" rel="nofollow ugc noopener" target="_blank">${url}</a>`,
					)
					.replace(COMMENT_LINE, "<br>")}</p>`,
		)
		.join("");
}

/** The count heading's words for `n` comments: the theme's where the record knows them, else EmDash's own (none at zero). */
function commentHeading(area: WpShellCommentArea, n: number, title: string): string {
	const h = area.heading;
	if (!h) return "";
	const known = n === 0 ? h.zero : n === 1 ? h.one : h.many;
	const words =
		known !== undefined
			? known.replace("%d", String(n)).replace("%t", () => title)
			: n === 0
				? null
				: n === 1
					? "1 Comment"
					: `${n} Comments`;
	return words === null ? "" : h.item.map((x) => (isText(x) ? x : escapeHtml(words))).join("");
}

/**
 * The comments in the theme's markup for one comment, and their replies in
 * the list the theme nests them in, each with the classes WordPress's
 * comment_class() gives it (its place, its thread's, its depth).
 */
function commentList(
	list: NonNullable<WpShellCommentArea["list"]>,
	items: readonly WpShellComment[],
	zone: { timeZone?: string; utcOffset?: number },
): string {
	let alt = 0;
	let thread = 0;
	const around = (t: readonly WpShellCommentPart[], inner: string) =>
		t.map((x) => (isText(x) ? x : inner)).join("");
	const one = (c: WpShellComment, depth: number): string => {
		const replies = c.replies ?? [];
		const cls = [
			list.classes,
			alt % 2 ? "odd alt" : "even",
			depth === 1 ? (thread % 2 ? "thread-odd thread-alt" : "thread-even") : "",
			`depth-${depth}`,
			replies.length > 0 ? "parent" : "",
		]
			.filter(Boolean)
			.join(" ");
		alt++;
		if (depth === 1) thread++;
		const date = new Date(c.createdAt);
		let out = "";
		for (const x of list.comment) {
			if (isText(x)) out += x;
			else if (x.s === "cls") out += escapeAttr(cls);
			else if (x.s === "id") out += escapeAttr(c.id);
			else if (x.s === "author") out += escapeHtml(c.authorName);
			else if (x.s === "date")
				out +=
					list.date && !Number.isNaN(date.getTime())
						? escapeHtml(formatWpDate(date, list.date, zone))
						: "";
			else if (x.s === "time")
				out +=
					list.time && !Number.isNaN(date.getTime())
						? escapeHtml(formatWpTime(date, list.time, zone))
						: "";
			else if (x.s === "text") out += commentText(c.body);
			else if (x.s === "replies" && replies.length > 0)
				out += around(list.replies, replies.map((r) => one(r, depth + 1)).join(""));
		}
		return out;
	};
	return around(list.item, items.map((c) => one(c, 1)).join(""));
}

/** A reply form box, as EmDash's CommentForm draws it, with the theme's id, classes and size. */
function commentControl(
	field: WpShellCommentField,
	x: Extract<WpShellCommentHole, { s: "control" }>,
): string {
	const own = `${attr("id", x.id)}${attr("class", x.class)}`;
	const hint = attr("placeholder", x.placeholder);
	if (field === "body")
		return `<textarea${own} name="body" required maxlength="5000"${attr("rows", x.rows ?? 4)}${attr("cols", x.cols)}${hint}></textarea>`;
	if (field === "authorName")
		return `<input type="text"${own} name="authorName" required maxlength="100"${attr("size", x.size)}${hint}>`;
	return `<input type="email"${own} name="authorEmail" required${attr("size", x.size)}${hint}>`;
}

/**
 * A post's comments drawn in the theme's comment area (the record's post
 * layout's `commentArea`): the count heading in the theme's words, the
 * approved comments in its markup for one, and the reply block with EmDash's
 * comment form in its markup for each box. It is EmDash's CommentForm's own
 * form: the same element attributes its client finds it by, the same
 * endpoint, field names, types and limits, the same honeypot and status
 * line; for a signed-in user, its name and email in place of those two boxes,
 * as CommentForm draws them. What the record has none of the theme's for is
 * EmDash's own component (`emdash`). Every value is escaped here.
 */
export function renderWpShellComments(
	post: WpShellPostLayout,
	o: {
		endpoint: string;
		total: number;
		items: readonly WpShellComment[];
		title: string;
		user?: WpShellCommentUser | null;
	},
): WpShellCommentsPiece[] {
	const area = post.commentArea;
	if (!area) return [];
	const out: WpShellCommentsPiece[] = [];
	const push = (html: string) => {
		const last = out.at(-1);
		if (last && "html" in last) last.html += html;
		else out.push({ html });
	};
	const { user } = o;
	let signedIn = false;
	for (const p of area.parts) {
		if (isText(p)) push(p);
		else if (p.s === "heading") push(commentHeading(area, o.total, o.title));
		else if (p.s === "list") {
			if (o.items.length === 0) continue;
			if (area.list) push(commentList(area.list, o.items, post));
			else out.push({ emdash: "list" });
		} else if (p.s === "respond") {
			for (const x of area.respond) {
				if (isText(x)) push(x);
				else if (x.s === "emdash") out.push({ emdash: "form" });
				else if (x.s === "form")
					push(
						`<form${attr("id", x.id)}${attr("class", x.class)} data-ec-comment-form${attr("data-endpoint", o.endpoint)}${attr("data-user-name", user?.name ?? "")}${attr("data-user-email", user?.email ?? "")}>`,
					);
				else if (x.s === "/form") push(`${COMMENT_HONEYPOT}${COMMENT_STATUS}</form>`);
				else if (x.s === "field") {
					// A signed-in user's name and email, as CommentForm shows them, where the theme's boxes for them go.
					if (user && x.field !== "body") {
						if (!signedIn)
							push(
								`<div class="ec-comment-user-info"><span class="ec-comment-user-name">${escapeHtml(user.name ?? "")}</span><span class="ec-comment-user-email">${escapeHtml(user.email ?? "")}</span></div>`,
							);
						signedIn = true;
						continue;
					}
					for (const y of area.fields?.[x.field] ?? []) {
						if (isText(y)) push(y);
						else if (y.s === "control") push(commentControl(x.field, y));
						else if (y.s === "label") push(`<label${attr("for", y.for)}${attr("class", y.class)}>`);
						else if (y.s === "/label") push("</label>");
					}
				} else if (x.s === "label") push(`<label${attr("for", x.for)}${attr("class", x.class)}>`);
				else if (x.s === "/label") push("</label>");
				else if (x.s === "submit") {
					const cls = [x.class, "ec-comment-form-submit"].filter(Boolean).join(" ");
					push(
						x.tag === "input"
							? `<input type="submit"${attr("id", x.id)}${attr("class", cls)}${attr("value", x.label)}>`
							: `<button type="submit"${attr("id", x.id)}${attr("class", cls)}>${escapeHtml(x.label)}</button>`,
					);
				}
			}
		}
	}
	return out;
}

/**
 * What the layout draws: markup, the element that holds the title, the one
 * that holds the content (and, in a post, what the theme drew at the end of
 * it), or the theme's comment element, which holds EmDash's comments.
 */
export type WpShellPiece =
	| { html: string }
	| { title: WpShellElement }
	| { content: WpShellElement; end?: string }
	| { comments: WpShellElement };

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
	/** The page's slug (the home's page's, for the home): a page cut on its own draws its own layout, and `titles` names pages by it. */
	slug?: string | null;
	/** The entry's title, for the chrome that prints it as text (titleText). */
	title?: string;
	/** The site's latest posts, newest first, for a listing slot. */
	posts?: readonly WpShellPost[] | null;
	/** The single post being drawn, for the post layout's holes. */
	post?: WpShellPostFill | null;
	/** The publication dates of EmDash's published posts, for an archives slot; null when they could not be read. */
	dates?: readonly Date[] | null;
	/** Where the site's date archives are, for an archives slot's links. */
	dateSite?: Pick<WpShellDateSite, "paths" | "zone">;
	/** What a sign-up posts to and says; null or unset, and a subscribe slot draws nothing (the site takes no sign-ups). */
	subscribe?: WpShellSubscribeFill | null;
}

/** A post's category or tag, as EmDash hydrates it. */
export interface WpShellPostTerm {
	label: string;
	slug: string;
}

/** What EmDash knows of the single post being drawn, for the post layout's holes. */
export interface WpShellPostFill {
	/** The post's path on the site. */
	url: string;
	/** The post's address, for its share links; none, and they are not drawn. */
	absoluteUrl?: string | null;
	title: string;
	date?: Date | null;
	/** The byline's name. */
	author?: string | null;
	categories?: readonly WpShellPostTerm[];
	tags?: readonly WpShellPostTerm[];
	/** Its approved comments; unknown, and the count is not drawn. */
	comments?: number | null;
	/** The featured image's path, when it is one of the site's own files, its width, and its alt text. */
	image?: string | null;
	imageWidth?: number | null;
	alt?: string | null;
	/** The byline's bio, a blank line between its paragraphs, and its avatar's path when it is one of the site's own files. */
	bio?: string | null;
	avatar?: string | null;
	/** The posts published before and after it. */
	prev?: { title: string; url: string } | null;
	next?: { title: string; url: string } | null;
}

/** The layout a kind of page is drawn with: a page of a slug cut on its own draws its own. */
export function layoutFor(shell: WpShell, kind: WpShellKind, slug?: string | null): WpShellLayout {
	if (kind === "home" && shell.home) return shell.home;
	if (kind === "post" && shell.post) return shell.post;
	const own =
		kind === "page" && slug
			? shell.pages?.find((p) => p.slug === slug || p.also?.includes(slug))
			: undefined;
	return own ?? shell;
}

/** A page's own (WpShellPageOwn), for a page or the home of that slug; never a post's or an archive's. */
function pageOwnFor(
	shell: WpShell,
	kind: WpShellKind,
	slug?: string | null,
): WpShellPageOwn | undefined {
	return (kind === "page" || kind === "home") && slug
		? shell.pageOwn?.find((o) => o.slug === slug)
		: undefined;
}

/** The stylesheets a page is drawn with, in cascade order: its layout's, then its own (WpShellPageOwn). */
export function stylesFor(shell: WpShell, kind: WpShellKind, slug?: string | null): string[] {
	return [...layoutFor(shell, kind, slug).styles, ...(pageOwnFor(shell, kind, slug)?.styles ?? [])];
}

/**
 * Whether a page drawn in the record's own layout prints its title, as the
 * record's `titles` says: the page (or the home) of a slug it names, and every
 * other page and post by the site's choice. A page in a layout of its own draws
 * that layout's title.
 */
export function drawsTitle(shell: WpShell, kind: WpShellKind, slug?: string | null): boolean {
	const t = shell.titles;
	if (!t || layoutFor(shell, kind, slug) !== shell) return true;
	const named = kind !== "post" && !!slug && ("hidden" in t ? t.hidden : t.shown).includes(slug);
	return "hidden" in t ? !named : named;
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

// --- a single post --------------------------------------------------------------

const byLabel = (terms: readonly WpShellPostTerm[] | undefined) =>
	[...(terms ?? [])].toSorted((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));

/** Where the site serves a term's posts (pages/category/[slug], pages/tag/[slug]). */
const termHref = (taxonomy: "category" | "tag", t: WpShellPostTerm) =>
	`/${taxonomy}/${encodeURIComponent(t.slug)}`;

/** Each network's own share page for a post: an address of this file's, and the post's, nothing of the record's. */
const SHARE_PAGE: Record<(typeof SHARE_HOLES)[number], (url: string, title: string) => string> = {
	"share-x": (url, title) =>
		`https://x.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
	"share-facebook": (url) =>
		`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
	"share-linkedin": (url) =>
		`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
	"share-email": (url, title) =>
		`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`,
};
const isShareHole = (h: WpShellPostHole): h is (typeof SHARE_HOLES)[number] =>
	(SHARE_HOLES as readonly string[]).includes(h);

/** The comment count's phrase for `n` comments, when the record knows the one for its count. */
function commentPhrase(post: WpShellPostLayout, n: number | null | undefined): string | null {
	if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || !post.comments) return null;
	const phrase = n === 0 ? post.comments.zero : n === 1 ? post.comments.one : post.comments.many;
	return phrase === undefined ? null : phrase.replace("%d", String(n));
}

/** Whether a post's featured image is drawn: one of the site's own files, as wide as the theme draws one. */
export function featuredDrawn(post: WpShellPostLayout, p: WpShellPostFill): boolean {
	const f = post.featured;
	if (!f || !p.image || !ownFile(p.image) || !MEDIA_SRC.test(p.image)) return false;
	if (f.minWidth === 0) return true;
	return typeof p.imageWidth === "number" && p.imageWidth >= f.minWidth;
}

/**
 * A post template filled for one post: every text escaped, every link the
 * post's own, a term's page, or its network's share page, every markup hole
 * from the record's own sub-templates. Null when a hole it needs has nothing
 * to draw (a meta with a date, for a post with none), so the caller draws
 * nothing of it.
 */
function fillPost(
	t: readonly WpShellPostPart[],
	post: WpShellPostLayout,
	p: WpShellPostFill,
	term?: {
		href: string;
		label: string;
		terms?: string;
		src?: string;
		adj?: { title: string; url: string };
	},
): string | null {
	let out = "";
	for (const x of t) {
		if (typeof x === "string") {
			out += x;
			continue;
		}
		const h = x.s;
		if (h === "href") out += escapeAttr(safeHref(term ? term.href : p.url));
		else if (h === "label") out += escapeHtml(term?.label ?? "");
		else if (h === "terms") out += term?.terms ?? "";
		else if (h === "title") out += escapeHtml(p.title);
		else if (h === "date") {
			if (!p.date || !post.date) return null;
			out += escapeHtml(formatWpDate(p.date, post.date, post));
		} else if (h === "author") {
			if (!p.author) return null;
			out += escapeHtml(p.author);
		} else if (h === "count") {
			const phrase = commentPhrase(post, p.comments);
			if (phrase === null) return null;
			out += escapeHtml(phrase);
		} else if (h === "categories" || h === "tags") {
			const taxonomy = h === "categories" ? "category" : "tag";
			const shape = post.terms?.[taxonomy];
			const list = byLabel(h === "categories" ? p.categories : p.tags);
			if (!shape || list.length === 0) continue;
			const terms = list
				.map(
					(one) =>
						fillPost(shape.term, post, p, { href: termHref(taxonomy, one), label: one.label }) ??
						"",
				)
				.join(escapeHtml(shape.sep));
			out += fillPost(shape.item, post, p, { href: "#", label: "", terms }) ?? "";
		} else if (h === "comments") {
			out += post.comments ? (fillPost(post.comments.item, post, p) ?? "") : "";
		} else if (h === "src") out += escapeAttr(term?.src ?? p.image ?? "");
		else if (h === "alt") out += escapeAttr(p.alt ?? "");
		else if (h === "name") {
			if (!p.author) return null;
			out += escapeHtml(p.author);
		} else if (h === "bio") {
			out += (p.bio ?? "")
				.split(PARAGRAPHS)
				.map((para) => para.trim())
				.filter(Boolean)
				.map((para) => `<p>${escapeHtml(para)}</p>`)
				.join("");
		} else if (h === "avatar") {
			const own = p.avatar && ownFile(p.avatar) && MEDIA_SRC.test(p.avatar) ? p.avatar : null;
			if (own && post.author?.avatar)
				out += fillPost(post.author.avatar, post, p, { href: "#", label: "", src: own }) ?? "";
		} else if (h === "prev" || h === "next") {
			const adj = p[h];
			const side = post.adjacent?.[h];
			if (adj && side) out += fillPost(side, post, p, { href: "#", label: "", adj }) ?? "";
		} else if (h === "adjHref") out += escapeAttr(safeHref(term?.adj?.url ?? "#"));
		else if (h === "adjTitle") out += escapeHtml(term?.adj?.title ?? "");
		else if (isShareHole(h)) {
			if (!p.absoluteUrl) return null;
			out += escapeAttr(SHARE_PAGE[h](p.absoluteUrl, p.title));
		} else return null;
	}
	return out;
}

/**
 * A post's values for the post layout, from its entry as EmDash hydrates it:
 * its first byline's name, its categories and tags, its date, its featured
 * image when it is one of the site's own files, and the comment count the
 * route read (only where the layout prints one).
 */
export function wpShellPostFill(
	data: unknown,
	o: {
		url: string;
		origin: string;
		comments: number | null;
		prev?: { title: string; url: string } | null;
		next?: { title: string; url: string } | null;
	},
): WpShellPostFill {
	const d = isObject(data) ? data : {};
	const credit: unknown = Array.isArray(d.bylines) ? d.bylines[0] : undefined;
	const byline =
		isObject(credit) && isObject(credit.byline)
			? credit.byline
			: isObject(d.byline)
				? d.byline
				: null;
	const terms = isObject(d.terms) ? d.terms : {};
	const list = (name: string): WpShellPostTerm[] => {
		const v = terms[name];
		return Array.isArray(v)
			? v.flatMap((t) =>
					isObject(t) && isText(t.label) && isText(t.slug)
						? [{ label: t.label, slug: t.slug }]
						: [],
				)
			: [];
	};
	const image = d.featured_image;
	const media = isObject(image) ? image : null;
	const key = byline && isText(byline.avatarStorageKey) ? byline.avatarStorageKey : "";
	const avatar = key ? `${MEDIA_PATH}${key}` : null;
	return {
		url: o.url,
		absoluteUrl: URL.parse(o.url, o.origin)?.href ?? null,
		title: isText(d.title) ? d.title : "",
		date: d.publishedAt instanceof Date ? d.publishedAt : null,
		author: byline && isText(byline.displayName) ? byline.displayName : null,
		categories: list("category"),
		tags: list("tag"),
		comments: o.comments,
		image: ownImagePath(image),
		imageWidth: media && typeof media.width === "number" ? media.width : null,
		alt: media && isText(media.alt) ? media.alt : "",
		bio: byline && isText(byline.bio) ? byline.bio : null,
		avatar: avatar && ownFile(avatar) && MEDIA_SRC.test(avatar) ? avatar : null,
		prev: o.prev ?? null,
		next: o.next ?? null,
	};
}

/** The trail's category crumb for a post: its first category by name, which WordPress's trail names. */
function trailTermHtml(post: WpShellPostLayout, p: WpShellPostFill): string {
	const first = byLabel(p.categories)[0];
	if (!post.trailTerm || !first) return "";
	return (
		fillPost(post.trailTerm, post, p, { href: termHref("category", first), label: first.label }) ??
		""
	);
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
	const layout = layoutFor(shell, fill.kind ?? "page", fill.slug);
	// The post layout's own slots draw only for a post, and only from its own templates.
	const post = layout === shell.post && fill.post ? shell.post : null;
	const postHtml = (t: readonly WpShellPostPart[] | undefined) =>
		post && t && fill.post ? (fillPost(t, post, fill.post) ?? "") : "";
	for (const p of layout.parts) {
		if ("html" in p) push(p.html);
		else if (p.slot === "titleText") push(escapeHtml(fill.title ?? ""));
		else if (p.slot === "title") {
			if (drawsTitle(shell, fill.kind ?? "page", fill.slug)) out.push({ title: element(p) });
		} else if (p.slot === "content") {
			const end = postHtml(post?.share);
			out.push({ content: element(p), ...(end ? { end } : {}) });
		} else if (p.slot === "comments") out.push({ comments: element(p) });
		else if (p.slot === "postMeta") push(postHtml(post?.meta[p.meta]));
		else if (p.slot === "featured") {
			if (post && fill.post && featuredDrawn(post, fill.post)) push(postHtml(post.featured?.item));
		} else if (p.slot === "trailTerm") {
			if (post && fill.post) push(trailTermHtml(post, fill.post));
		} else if (p.slot === "authorBio") push(postHtml(post?.author?.item));
		else if (p.slot === "adjacent") {
			if (fill.post?.prev || fill.post?.next) push(postHtml(post?.adjacent?.item));
		} else if (p.slot === "siteTitle") push(escapeHtml(fill.siteTitle ?? p.fallback));
		else if (p.slot === "tagline") push(escapeHtml(fill.tagline ?? p.fallback));
		else if (p.slot === "logo") push(logoHtml(p, fill.logoUrl));
		else if (p.slot === "listing") {
			const listing = shell.listings?.[p.listing];
			if (listing) push(renderListing(listing, fill.posts ?? []));
		} else if (p.slot === "archives") {
			const archives = shell.archives?.[p.archives];
			if (archives)
				push(renderArchives(archives, fill.dates ?? null, fill.dateSite ?? wpShellDateSite(shell)));
		} else if (p.slot === "subscribe") {
			const sub = shell.subscribe?.[p.subscribe];
			if (sub && fill.subscribe) push(renderWpShellSubscribe(sub, fill.subscribe));
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
	archive: ["archive", "date"],
};
const ANY_KIND = new Set(Object.values(KIND_CLASSES).flat());
/** The classes WordPress (and the themes that follow it) give a single entry's page, and never an archive. */
const SINGULAR = new Set(["wp-singular", "singular"]);
const WHITESPACE = /\s+/;

export function bodyClassFor(shell: WpShell, kind: WpShellKind, slug?: string | null): string {
	// The page's own classes (`page-id-21`), after its layout's.
	const page = (pageOwnFor(shell, kind, slug)?.body ?? "")
		.split(WHITESPACE)
		.filter((c) => c !== "");
	const withPage = (classes: readonly string[]) =>
		[...classes, ...page.filter((c) => !classes.includes(c))].join(" ");
	// The home layout was cut from the front page, a page layout from its page: their classes are their own.
	const own = layoutFor(shell, kind, slug);
	if (own !== shell)
		return page.length > 0
			? withPage(own.body.class.split(WHITESPACE).filter((c) => c !== ""))
			: own.body.class;
	const kept = shell.body.class
		.split(WHITESPACE)
		.filter((c) => c !== "" && !ANY_KIND.has(c) && !(kind === "archive" && SINGULAR.has(c)));
	return page.length > 0
		? withPage([...KIND_CLASSES[kind], ...kept])
		: [...KIND_CLASSES[kind], ...kept].join(" ");
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
):
	| { kind: "home" }
	| { kind: "page" | "post"; slug: string }
	| { kind: "archive"; archive: WpDateArchive }
	| null {
	const segments = (path ?? "").split("/").filter(Boolean);
	if (segments.length === 1 && segments[0] === "home") return { kind: "home" };
	// `/wp-shell/archive/2023/07`, `/wp-shell/archive/2023/07/page/2`: a date archive, at WordPress's own shape.
	if (segments[0] === "archive") {
		const archive = parseDatePath(`/${segments.slice(1).join("/")}/`);
		return archive ? { kind: "archive", archive } : null;
	}
	if (segments.length !== 2) return null;
	const [collection, slug] = segments;
	if (collection === "pages") return { kind: "page", slug };
	if (collection === "posts") return { kind: "post", slug };
	return null;
}
