/**
 * Per-entry SEO from a WordPress export: the title, description, robots,
 * canonical and social image that Yoast SEO, Rank Math and All in One SEO keep
 * in postmeta, mapped onto EmDash's own SEO fields.
 *
 * A value is stored only when EmDash will render it the way WordPress did. A
 * template variable whose value the export does not hold, a canonical that
 * points off the site, an image that is not one of the export's own
 * attachments: each is left out and counted by reason, never stored raw.
 */

import type { WxrPost, WxrSite } from "../cli/wxr/parser.js";
import type { ContentSeoInput } from "../database/repositories/types.js";

export type WxrSeoField = "title" | "description" | "robots" | "canonical" | "image";

export type WxrSeoDropReason =
	| "unresolved-variable"
	| "too-long"
	| "only-the-site-name"
	| "not-a-url"
	| "off-site"
	| "not-an-entry"
	| "not-in-media"
	| "nofollow-without-noindex"
	| "collection-has-no-seo";

export type WxrSeoNote = "noindex-adds-nofollow" | "site-name-appended";

export interface WxrSeoSite {
	/** `blogname`, the value of `%%sitename%%`. */
	title?: string;
	/** `blogdescription`, the value of `%%sitedesc%%`. */
	description?: string;
	/** The source site's home URL. A canonical is carried only when it points at this host. */
	link?: string;
	/** Attachment id -> URL for this export's media. */
	attachments: ReadonlyMap<string, string>;
	/** The same attachments by URL, keyed by {@link mediaKey}. */
	media: ReadonlyMap<string, string>;
	/** {@link wxrUrlKey} of a source permalink -> the EmDash path of the entry imported from it. */
	entryPaths: ReadonlyMap<string, string>;
}

export interface WxrSeoExtraction {
	/** True when the item's postmeta sets any field this module carries. */
	found: boolean;
	/** The fields to store. Empty when nothing can be carried. */
	seo: ContentSeoInput;
	/** Overrides that equal what EmDash renders without one, so nothing is stored for them. */
	asDefault: WxrSeoField[];
	dropped: Array<{ field: WxrSeoField; reason: WxrSeoDropReason; variables?: string[] }>;
	/** Carried, with a difference EmDash's SEO fields cannot avoid. */
	notes: WxrSeoNote[];
}

export interface WxrSeoTally {
	/** Entries written this run whose postmeta set any SEO field. */
	entries: number;
	/** Entries given each field. */
	carried: Record<WxrSeoField, number>;
	/** Overrides equal to EmDash's default, not stored, by field. */
	asDefault: Record<string, number>;
	/** Existing entries (skipped) that had no SEO row and were given one. */
	filledExisting: number;
	/** Existing entries (skipped) that already had an SEO row, left as they are. */
	keptExisting: number;
	/** `field:reason` -> entries. */
	dropped: Record<string, number>;
	/** Variable name -> values it kept from being carried. */
	unresolvedVariables: Record<string, number>;
	notes: Record<string, number>;
}

/** The limits the content API's SEO input accepts, so an imported value stays editable. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 500;

const SEP = "\u0000sep\u0000";
const WHITESPACE_RE = /\s+/g;
const TRAILING_SLASHES_RE = /\/+$/;
const WWW_RE = /^www\./;
const SIZE_SUFFIX_RE = /-\d+x\d+(\.[a-z0-9]+)$/i;
const QUERY_OR_HASH_RE = /[?#].*$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const REGEX_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g;
const SEPARATOR_CHARS = "-–—|:·•*⋆~«»<>";
const PHP_ARRAY_STRING_RE = /s:\d+:"([^"]*)";/g;

type Family = "yoast" | "rankmath" | "aioseo";

const YOAST_VARIABLE_RE = /%%([A-Za-z0-9_-]+)%%/g;
const RANKMATH_VARIABLE_RE = /%([A-Za-z_]+)(?:\([^()%]*\))?%/g;
const AIOSEO_TAG_RE = /#([a-z_]+)(?:-[A-Za-z0-9_-]+)?/g;

/** All in One SEO smart tags. A `#word` outside this list is literal text in its output. */
const AIOSEO_TAGS = new Set([
	"alt_tag",
	"archive_date",
	"archive_title",
	"attachment_caption",
	"attachment_description",
	"author_bio",
	"author_first_name",
	"author_last_name",
	"author_name",
	"author_url",
	"categories",
	"category",
	"category_description",
	"current_date",
	"current_day",
	"current_month",
	"current_year",
	"custom_field",
	"page_number",
	"parent_title",
	"permalink",
	"post_content",
	"post_date",
	"post_day",
	"post_excerpt",
	"post_excerpt_only",
	"post_month",
	"post_title",
	"post_year",
	"search_term",
	"separator_sa",
	"site_title",
	"tagline",
	"tax_name",
	"tax_parent_name",
	"taxonomy_description",
	"taxonomy_title",
]);

/** Each family's variable name -> the one name this module resolves. */
const ALIASES: Record<Family, Record<string, string>> = {
	yoast: {
		title: "title",
		sitename: "sitename",
		sitedesc: "sitedesc",
		sep: "sep",
		page: "page",
		excerpt: "excerpt",
		excerpt_only: "excerpt_only",
	},
	rankmath: {
		title: "title",
		sitename: "sitename",
		sitedesc: "sitedesc",
		sep: "sep",
		page: "page",
		excerpt: "excerpt",
		excerpt_only: "excerpt_only",
	},
	aioseo: {
		post_title: "title",
		site_title: "sitename",
		tagline: "sitedesc",
		separator_sa: "sep",
		page_number: "page",
		post_excerpt: "excerpt",
		post_excerpt_only: "excerpt_only",
	},
};

interface Source {
	family: Family;
	value: string;
}

const TITLE_KEYS: Array<[Family, string]> = [
	["yoast", "_yoast_wpseo_title"],
	["rankmath", "rank_math_title"],
	["aioseo", "_aioseo_title"],
	["aioseo", "_aioseop_title"],
];

const DESCRIPTION_KEYS: Array<[Family, string]> = [
	["yoast", "_yoast_wpseo_metadesc"],
	["rankmath", "rank_math_description"],
	["aioseo", "_aioseo_description"],
	["aioseo", "_aioseop_description"],
];

const CANONICAL_KEYS = ["_yoast_wpseo_canonical", "rank_math_canonical_url", "_aioseop_custom_link"];

const IMAGE_KEYS: Array<[idKey: string, urlKey: string]> = [
	["_yoast_wpseo_opengraph-image-id", "_yoast_wpseo_opengraph-image"],
	["rank_math_facebook_image_id", "rank_math_facebook_image"],
];

function metaValue(post: WxrPost, key: string): string | undefined {
	const value = post.meta.get(key)?.trim();
	return value ? value : undefined;
}

function firstSource(post: WxrPost, keys: Array<[Family, string]>): Source | undefined {
	for (const [family, key] of keys) {
		const value = metaValue(post, key);
		if (value !== undefined) return { family, value };
	}
	return undefined;
}

function variablesOf(family: Family, value: string): Array<{ token: string; name: string }> {
	const re =
		family === "aioseo"
			? AIOSEO_TAG_RE
			: family === "yoast"
				? YOAST_VARIABLE_RE
				: RANKMATH_VARIABLE_RE;
	const found: Array<{ token: string; name: string }> = [];
	for (const [token, name] of value.matchAll(re)) {
		if (family === "aioseo" && !AIOSEO_TAGS.has(name)) continue;
		found.push({ token, name });
	}
	return found;
}

/**
 * Replace the variables the export holds a value for. `sep` becomes a marker:
 * its value lives in the plugin's settings, which a WXR does not carry.
 */
function resolveVariables(
	source: Source,
	post: WxrPost,
	site: WxrSeoSite,
): { text: string; unresolved: string[] } {
	const unresolved: string[] = [];
	const excerpt = post.excerpt?.trim() ?? "";
	const values: Record<string, string | undefined> = {
		title: post.title?.trim() ?? "",
		sitename: site.title?.trim() || undefined,
		sitedesc: site.description?.trim() ?? "",
		sep: SEP,
		page: "",
		excerpt: excerpt || undefined,
		excerpt_only: excerpt,
	};
	let text = source.value;
	for (const { token, name } of variablesOf(source.family, source.value)) {
		const known = ALIASES[source.family][name];
		const value = known === undefined ? undefined : values[known];
		if (value === undefined) {
			unresolved.push(name);
			continue;
		}
		text = text.replace(token, () => value);
	}
	return { text, unresolved: [...new Set(unresolved)] };
}

function collapse(text: string): string {
	return text.replace(WHITESPACE_RE, " ").trim();
}

function escapeRegex(text: string): string {
	return text.replace(REGEX_SPECIAL_RE, "\\$&");
}

/** Remove a trailing `<separator> <site name>`: EmDash appends the site name itself. */
function withoutSiteName(title: string, siteTitle: string | undefined): { title: string; had: boolean } {
	const name = siteTitle?.trim();
	if (!name) return { title, had: false };
	const separators = `${escapeRegex(SEP)}|[${escapeRegex(SEPARATOR_CHARS)}]`;
	const tail = new RegExp(`\\s*(?:${separators})\\s*${escapeRegex(name)}$`);
	if (tail.test(title)) return { title: title.replace(tail, "").trim(), had: true };
	return { title, had: title === name };
}

function trimSeparators(text: string): string {
	let out = text.trim();
	for (;;) {
		const next = out.replace(new RegExp(`^${escapeRegex(SEP)}|${escapeRegex(SEP)}$`, "g"), "").trim();
		if (next === out) return out;
		out = next;
	}
}

/** Host without `www.`, path without trailing slashes, and the query. */
export function wxrUrlKey(url: string, base?: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url, base);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	const host = parsed.hostname.toLowerCase().replace(WWW_RE, "");
	const path = parsed.pathname.replace(TRAILING_SLASHES_RE, "") || "/";
	return `${host}${path}${parsed.search}`;
}

function parseUrl(url: string | undefined): URL | undefined {
	if (!url) return undefined;
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
}

function ownKeys(post: WxrPost, site: WxrSeoSite): Set<string> {
	const keys = new Set<string>();
	for (const url of [post.link, post.guid]) {
		const key = url ? wxrUrlKey(url, site.link) : undefined;
		if (key) keys.add(key);
	}
	if (post.id !== undefined && site.link) {
		for (const query of [`?p=${post.id}`, `?page_id=${post.id}`]) {
			const key = wxrUrlKey(`/${query}`, site.link);
			if (key) keys.add(key);
		}
	}
	return keys;
}

function mediaKey(url: string): string {
	return url
		.replace(SCHEME_RE, "")
		.replace(QUERY_OR_HASH_RE, "")
		.replace(SIZE_SUFFIX_RE, "$1")
		.replace(WWW_RE, "")
		.toLowerCase();
}

function robotsTokens(value: string): Set<string> {
	if (value.startsWith("a:")) {
		return new Set(Array.from(value.matchAll(PHP_ARRAY_STRING_RE), ([, token]) => token.toLowerCase()));
	}
	if (value.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed)) {
				return new Set(parsed.filter((t) => typeof t === "string").map((t) => t.toLowerCase()));
			}
		} catch {
			return new Set();
		}
	}
	return new Set(
		value
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean),
	);
}

function robotsOf(post: WxrPost): { noindex: boolean; nofollow: boolean } | undefined {
	const yoastIndex = metaValue(post, "_yoast_wpseo_meta-robots-noindex");
	const yoastFollow = metaValue(post, "_yoast_wpseo_meta-robots-nofollow");
	if (yoastIndex === "1" || yoastFollow === "1") {
		return { noindex: yoastIndex === "1", nofollow: yoastFollow === "1" };
	}
	const rankMath = metaValue(post, "rank_math_robots");
	if (rankMath) {
		const tokens = robotsTokens(rankMath);
		if (tokens.has("noindex") || tokens.has("nofollow")) {
			return { noindex: tokens.has("noindex"), nofollow: tokens.has("nofollow") };
		}
	}
	const aioIndex = metaValue(post, "_aioseop_noindex");
	const aioFollow = metaValue(post, "_aioseop_nofollow");
	if (aioIndex === "on" || aioFollow === "on") {
		return { noindex: aioIndex === "on", nofollow: aioFollow === "on" };
	}
	return undefined;
}

function imageOf(post: WxrPost, site: WxrSeoSite): { url?: string; found: boolean } {
	let found = false;
	for (const [idKey, urlKey] of IMAGE_KEYS) {
		const id = metaValue(post, idKey);
		const url = metaValue(post, urlKey);
		if (id === undefined && url === undefined) continue;
		found = true;
		const byId = id === undefined ? undefined : site.attachments.get(id);
		if (byId) return { url: byId, found };
		const byUrl = url === undefined ? undefined : site.media.get(mediaKey(url));
		if (byUrl) return { url: byUrl, found };
	}
	return { found };
}

/**
 * Read one item's SEO postmeta. Pure: the caller decides whether the target
 * collection takes SEO, and writes.
 */
export function extractWxrSeo(post: WxrPost, site: WxrSeoSite): WxrSeoExtraction {
	const out: WxrSeoExtraction = { found: false, seo: {}, asDefault: [], dropped: [], notes: [] };
	const drop = (field: WxrSeoField, reason: WxrSeoDropReason, variables?: string[]) =>
		out.dropped.push(variables?.length ? { field, reason, variables } : { field, reason });

	const title = firstSource(post, TITLE_KEYS);
	if (title) {
		out.found = true;
		const { text, unresolved } = resolveVariables(title, post, site);
		const stripped = withoutSiteName(collapse(text), site.title);
		const value = trimSeparators(stripped.title);
		if (unresolved.length) drop("title", "unresolved-variable", unresolved);
		else if (value.includes(SEP)) drop("title", "unresolved-variable", ["sep"]);
		else if (!value || value === site.title?.trim()) drop("title", "only-the-site-name");
		else if (value.length > TITLE_MAX) drop("title", "too-long");
		else {
			if (value === post.title?.trim()) out.asDefault.push("title");
			else out.seo.title = value;
			if (!stripped.had) out.notes.push("site-name-appended");
		}
	}

	const description = firstSource(post, DESCRIPTION_KEYS);
	if (description) {
		out.found = true;
		const { text, unresolved } = resolveVariables(description, post, site);
		const value = collapse(text);
		if (unresolved.length) drop("description", "unresolved-variable", unresolved);
		else if (value.includes(SEP)) drop("description", "unresolved-variable", ["sep"]);
		else if (!value || value === post.excerpt?.trim()) out.asDefault.push("description");
		else if (value.length > DESCRIPTION_MAX) drop("description", "too-long");
		else out.seo.description = value;
	}

	const robots = robotsOf(post);
	if (robots) {
		out.found = true;
		if (robots.noindex) {
			out.seo.noIndex = true;
			if (!robots.nofollow) out.notes.push("noindex-adds-nofollow");
		} else drop("robots", "nofollow-without-noindex");
	}

	const canonical = CANONICAL_KEYS.map((key) => metaValue(post, key)).find(Boolean);
	if (canonical) {
		out.found = true;
		const key = wxrUrlKey(canonical, site.link);
		const home = parseUrl(site.link);
		const siteHost = home?.hostname.toLowerCase().replace(WWW_RE, "");
		if (!key || !home || !siteHost) drop("canonical", "not-a-url");
		else if (!key.startsWith(`${siteHost}/`)) drop("canonical", "off-site");
		else if (ownKeys(post, site).has(key)) out.asDefault.push("canonical");
		else {
			const path = site.entryPaths.get(key);
			if (path) out.seo.canonical = `${home.origin}${path}`;
			else drop("canonical", "not-an-entry");
		}
	}

	const image = imageOf(post, site);
	if (image.found) {
		out.found = true;
		if (image.url) out.seo.image = image.url;
		else drop("image", "not-in-media");
	}

	return out;
}

/** True when the extraction has at least one field to store. */
export function hasWxrSeo(extraction: WxrSeoExtraction): boolean {
	return Object.keys(extraction.seo).length > 0;
}

export function emptyWxrSeoTally(): WxrSeoTally {
	return {
		entries: 0,
		carried: { title: 0, description: 0, robots: 0, canonical: 0, image: 0 },
		asDefault: {},
		filledExisting: 0,
		keptExisting: 0,
		dropped: {},
		unresolvedVariables: {},
		notes: {},
	};
}

function bump(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

/** Count the extraction of one entry this run wrote. */
export function tallyWxrSeo(tally: WxrSeoTally, extraction: WxrSeoExtraction): void {
	if (!extraction.found) return;
	tally.entries++;
	const { seo } = extraction;
	if (seo.title) tally.carried.title++;
	if (seo.description) tally.carried.description++;
	if (seo.noIndex) tally.carried.robots++;
	if (seo.canonical) tally.carried.canonical++;
	if (seo.image) tally.carried.image++;
	for (const note of extraction.notes) bump(tally.notes, note);
	for (const field of extraction.asDefault) bump(tally.asDefault, field);
	for (const { field, reason, variables } of extraction.dropped) {
		bump(tally.dropped, `${field}:${reason}`);
		for (const name of variables ?? []) bump(tally.unresolvedVariables, name);
	}
}

/** Count an entry whose collection has no SEO fields: everything it set is dropped. */
export function tallyWxrSeoNoCollection(tally: WxrSeoTally, extraction: WxrSeoExtraction): void {
	if (!extraction.found) return;
	tally.entries++;
	bump(tally.dropped, "all:collection-has-no-seo");
}

/**
 * The context {@link extractWxrSeo} reads, from the parsed export and the
 * EmDash path each imported item gets.
 */
export function wxrSeoSite(
	site: WxrSite,
	attachments: ReadonlyArray<{ id?: number; url?: string }>,
	entryPaths: ReadonlyMap<string, string>,
): WxrSeoSite {
	const byId = new Map<string, string>();
	const media = new Map<string, string>();
	for (const attachment of attachments) {
		if (!attachment.url) continue;
		if (attachment.id !== undefined) byId.set(String(attachment.id), attachment.url);
		media.set(mediaKey(attachment.url), attachment.url);
	}
	return {
		title: site.title,
		description: site.description,
		link: site.link || site.baseBlogUrl || site.baseSiteUrl,
		attachments: byId,
		media,
		entryPaths,
	};
}
