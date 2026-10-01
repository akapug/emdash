/**
 * Classic iframes
 *
 * The classic editor keeps a player pasted into a post as the provider's own
 * `<iframe>` (YouTube's, Vimeo's, a map's, a form's), and WordPress prints it
 * as written. A player from a provider EmDash knows becomes an embed of the
 * provider's page URL, the block an autoembed becomes, so the site draws it
 * with its own embed component. An iframe from any other host is kept as
 * written, in an HTML block, as a `<!-- wp:html -->` iframe is.
 */

import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import { providerOfHost } from "./provider.js";
import type { PortableTextBlock } from "./types.js";

type Node = DefaultTreeAdapterMap["node"];

const IFRAME_TAG_PATTERN = /<iframe\b/i;
/** A web URL: http(s), or one on the page's own scheme (`//host/path`) */
const WEB_URL_PATTERN = /^(?:https?:)?\/\/[^/\s]/i;
const HOST_PATTERN = /^https?:\/\/([^/?#:]+)/i;
const QUERY_PATTERN = /\?([^#]*)/;
/** A YouTube start time: seconds, or a run of hours, minutes and seconds (`1m30s`) */
const START_TIME_PATTERN = /^(?:\d+[hms]?)+$/;
const VIMEO_HASH_PATTERN = /^\w+$/;

const startTime = (query: URLSearchParams) => {
	const t = query.get("start") ?? query.get("t");
	return t && START_TIME_PATTERN.test(t) ? `&t=${t}` : "";
};

/**
 * A provider's player URL, and its page URL from the parts the pattern
 * captures and the player's query; null where the player names no page.
 */
const PLAYERS: ReadonlyArray<
	readonly [RegExp, (m: RegExpExecArray, query: URLSearchParams) => string | null]
> = [
	[
		/^https?:\/\/(?:www\.|m\.)?youtube(?:-nocookie)?\.com\/embed(?:\/videoseries)?\/?(?=[?#]|$)/i,
		(_, q) => {
			const list = q.get("list");
			return list ? `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` : null;
		},
	],
	[
		/^https?:\/\/(?:www\.|m\.)?youtube(?:-nocookie)?\.com\/(?:embed|v)\/([\w-]+)/i,
		(m, q) => `https://www.youtube.com/watch?v=${m[1]}${startTime(q)}`,
	],
	[
		/^https?:\/\/youtu\.be\/([\w-]+)/i,
		(m, q) => `https://www.youtube.com/watch?v=${m[1]}${startTime(q)}`,
	],
	[
		/^https?:\/\/player\.vimeo\.com\/video\/(\d+)/i,
		(m, q) => {
			const hash = q.get("h");
			return `https://vimeo.com/${m[1]}${hash && VIMEO_HASH_PATTERN.test(hash) ? `/${hash}` : ""}`;
		},
	],
	[
		/^https?:\/\/open\.spotify\.com\/embed\/(track|episode|show|playlist|album)\/(\w+)/i,
		(m) => `https://open.spotify.com/${m[1]}/${m[2]}`,
	],
	[/^https?:\/\/w\.soundcloud\.com\/player\/?(?=[?#]|$)/i, (_, q) => q.get("url")],
	[
		/^https?:\/\/(?:www\.)?instagram\.com\/(p|reel|tv)\/([\w-]+)\/embed/i,
		(m) => `https://www.instagram.com/${m[1]}/${m[2]}/`,
	],
	[
		/^https?:\/\/codepen\.io\/([\w-]+)\/embed\/(?:preview\/)?(\w+)/i,
		(m) => `https://codepen.io/${m[1]}/pen/${m[2]}`,
	],
	[
		/^https?:\/\/(?:www\.|web\.)?facebook\.com\/plugins\/(?:video|post)\.php(?=[?#]|$)/i,
		(_, q) => q.get("href"),
	],
];

/**
 * An iframe in classic HTML whose src is a web URL
 */
export interface Iframe {
	/** Offset of the iframe's markup in the searched HTML */
	start: number;
	/** Offset just past it */
	end: number;
	/** The iframe as written */
	html: string;
	/** Its src, made absolute where it takes the page's scheme */
	src: string;
}

/**
 * The iframes a browser draws in `html` that have a web URL for their src, in
 * document order. An iframe in a comment, a script or other raw text is none.
 * One whose src is not a web URL (javascript:, data:, a relative path) shows
 * nothing an import can keep, so it is not found, and the text around it drops
 * it as before.
 */
export function findIframes(html: string, offset = 0): Iframe[] {
	if (!IFRAME_TAG_PATTERN.test(html)) return [];
	const found: Iframe[] = [];

	const walk = (nodes: Node[]) => {
		for (const node of nodes) {
			if (!("tagName" in node)) continue;
			const location = node.sourceCodeLocation;
			if (node.tagName !== "iframe" || !location?.startTag) {
				walk(node.childNodes);
				continue;
			}
			// A browser reads all that follows an iframe with no end tag as its fallback text, and
			// draws none of it; a page builder's `<iframe … />` is that. The text after it is kept.
			const end = location.endTag?.endOffset ?? location.startTag.endOffset;
			const src = node.attrs.find((a) => a.name === "src")?.value.trim() ?? "";
			if (WEB_URL_PATTERN.test(src)) {
				found.push({
					start: offset + location.startOffset,
					end: offset + end,
					html: html.slice(location.startOffset, end),
					src: src.startsWith("//") ? `https:${src}` : src,
				});
			}
			if (!location.endTag) found.push(...findIframes(html.slice(end), offset + end));
		}
	};
	walk(parseFragment(html, { sourceCodeLocationInfo: true }).childNodes);
	return found;
}

/**
 * The block for an iframe: an embed of the page a known provider's player
 * shows, or else the iframe as written
 */
export function iframeBlock(iframe: Iframe, generateKey: () => string): PortableTextBlock {
	const url = pageUrl(iframe.src);
	const provider = providerOfHost(HOST_PATTERN.exec(url)?.[1] ?? "");
	if (provider) {
		return { _type: "embed", _key: generateKey(), url, provider };
	}
	return { _type: "htmlBlock", _key: generateKey(), html: iframe.html };
}

/**
 * The provider's page URL for a player URL, or the player URL where it names none
 */
function pageUrl(src: string): string {
	const query = new URLSearchParams(QUERY_PATTERN.exec(src)?.[1]);
	for (const [player, page] of PLAYERS) {
		const m = player.exec(src);
		const url = m && page(m, query);
		if (url && HOST_PATTERN.test(url)) return url;
	}
	return src;
}
