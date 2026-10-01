/**
 * Classic iframes
 *
 * The classic editor keeps a player pasted into a post as the provider's own
 * `<iframe>` (YouTube's, Vimeo's, a map's, a form's), and WordPress prints it
 * as written. A player becomes an embed of the provider's page URL, the block
 * an autoembed becomes, where that page can be read from the player and
 * EmDash's embed component draws it: a YouTube video or a public Vimeo video
 * as a player, a Spotify, SoundCloud, Instagram, CodePen or Facebook page as
 * a link to it. Any other iframe is kept in an HTML block, as a
 * `<!-- wp:html -->` iframe is, so it plays where it did.
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
/**
 * A YouTube video id, the 11 characters EmDash's embed component plays.
 * `videoseries` (a playlist) and `live_stream` (a channel's stream) have
 * 11 characters too, and are no video.
 */
const YOUTUBE_VIDEO = String.raw`(?!videoseries|live_stream)([\w-]{11})(?![\w-])`;
/** What a kept iframe holds: the attributes that draw the frame, never srcdoc or an on* script */
const KEPT_ATTRIBUTES: ReadonlySet<string> = new Set([
	"src",
	"width",
	"height",
	"frameborder",
	"allow",
	"allowfullscreen",
	"title",
	"loading",
	"referrerpolicy",
]);
const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	'"': "&quot;",
	"<": "&lt;",
	">": "&gt;",
};
const ATTRIBUTE_ESCAPE_PATTERN = /[&"<>]/g;

const startTime = (query: URLSearchParams) => {
	const t = query.get("start") ?? query.get("t");
	return t && START_TIME_PATTERN.test(t) ? `&t=${t}` : "";
};
const youtubeVideo = (m: RegExpExecArray, query: URLSearchParams) =>
	`https://www.youtube.com/watch?v=${m[1]}${startTime(query)}`;

/**
 * Each provider's player URL, and the page URL read from the parts the
 * pattern captures and the player's query; null where the player shows no
 * page EmDash can draw. The page must be the provider's own.
 */
const PLAYERS: ReadonlyArray<
	readonly [
		provider: string,
		player: RegExp,
		page: (m: RegExpExecArray, query: URLSearchParams) => string | null,
	]
> = [
	[
		"youtube",
		new RegExp(
			String.raw`^https?:\/\/(?:www\.|m\.)?youtube(?:-nocookie)?\.com\/(?:embed|v)\/${YOUTUBE_VIDEO}`,
			"i",
		),
		youtubeVideo,
	],
	["youtube", new RegExp(String.raw`^https?:\/\/youtu\.be\/${YOUTUBE_VIDEO}`, "i"), youtubeVideo],
	// A public video: an unlisted one plays only with its hash, which the embed component does not pass
	[
		"vimeo",
		/^https?:\/\/player\.vimeo\.com\/video\/(\d+)(?=[?#]|$)/i,
		(m, q) => (q.has("h") ? null : `https://vimeo.com/${m[1]}`),
	],
	[
		"spotify",
		/^https?:\/\/open\.spotify\.com\/embed\/(track|episode|show|playlist|album)\/(\w+)/i,
		(m) => `https://open.spotify.com/${m[1]}/${m[2]}`,
	],
	// A private track's page needs its secret token
	[
		"soundcloud",
		/^https?:\/\/w\.soundcloud\.com\/player\/?(?=[?#]|$)/i,
		(_, q) => (q.has("secret_token") ? null : q.get("url")),
	],
	[
		"instagram",
		/^https?:\/\/(?:www\.)?instagram\.com\/(p|reel|tv)\/([\w-]+)\/embed/i,
		(m) => `https://www.instagram.com/${m[1]}/${m[2]}/`,
	],
	[
		"codepen",
		/^https?:\/\/codepen\.io\/([\w-]+)\/embed\/(?:preview\/)?(\w+)/i,
		(m) => `https://codepen.io/${m[1]}/pen/${m[2]}`,
	],
	[
		"facebook",
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
	/** The iframe rebuilt from the attributes that draw the frame */
	html: string;
	/** Its src, made absolute where it takes the page's scheme */
	src: string;
	/** The start tags of the elements it stands in, outermost first, with their offsets */
	within: ReadonlyArray<{ start: number; tag: string }>;
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

	// True once the rest of the HTML has been searched on its own
	const walk = (nodes: Node[], within: Iframe["within"]): boolean => {
		for (const node of nodes) {
			if (!("tagName" in node)) continue;
			const location = node.sourceCodeLocation;
			if (node.tagName !== "iframe" || !location?.startTag) {
				// An element the parser implies (a table's tbody) has no start tag to open again
				const at = location?.startTag;
				const tag = at
					? [{ start: offset + at.startOffset, tag: html.slice(at.startOffset, at.endOffset) }]
					: [];
				if (walk(node.childNodes, [...within, ...tag])) return true;
				continue;
			}
			const { startTag, endTag } = location;
			// A browser reads all that follows an iframe it finds no end tag for as fallback text, and
			// draws none of it; a page builder's `<iframe … />` is one. It ends at its start tag here,
			// and what follows is kept and searched on its own.
			const open = !endTag || html[startTag.endOffset - 2] === "/";
			const end = open ? startTag.endOffset : endTag.endOffset;
			const src = node.attrs.find((a) => a.name === "src")?.value.trim() ?? "";
			if (WEB_URL_PATTERN.test(src)) {
				const attrs = node.attrs
					.filter((a) => KEPT_ATTRIBUTES.has(a.name))
					.map((a) => (a.value ? ` ${a.name}="${escapeAttribute(a.value)}"` : ` ${a.name}`));
				found.push({
					start: offset + startTag.startOffset,
					end: offset + end,
					html: `<iframe${attrs.join("")}></iframe>`,
					src: src.startsWith("//") ? `https:${src}` : src,
					within,
				});
			}
			if (open) {
				found.push(...findIframes(html.slice(end), offset + end));
				return true;
			}
		}
		return false;
	};
	walk(parseFragment(html, { sourceCodeLocationInfo: true }).childNodes, []);
	return found;
}

/**
 * The start tags of the elements an iframe stands in that open at or after
 * `from`: the text after the iframe opens them again, so it keeps the link or
 * the bold run around it
 */
export function reopened(iframe: Pick<Iframe, "within">, from: number): string {
	return iframe.within
		.filter((e) => e.start >= from)
		.map((e) => e.tag)
		.join("");
}

/**
 * The block for an iframe: an embed of the page its player shows, where EmDash
 * draws that page, or else the iframe in an HTML block
 */
export function iframeBlock(iframe: Iframe, generateKey: () => string): PortableTextBlock {
	const page = pageOf(iframe.src);
	if (page) {
		return { _type: "embed", _key: generateKey(), url: page.url, provider: page.provider };
	}
	return { _type: "htmlBlock", _key: generateKey(), html: iframe.html };
}

/**
 * The provider's page for a player URL, where one can be read from it
 */
function pageOf(src: string): { url: string; provider: string } | undefined {
	const query = new URLSearchParams(QUERY_PATTERN.exec(src)?.[1]);
	for (const [provider, player, page] of PLAYERS) {
		const m = player.exec(src);
		const url = m && page(m, query);
		if (url && providerOfHost(HOST_PATTERN.exec(url)?.[1] ?? "") === provider) {
			return { url, provider };
		}
	}
	return undefined;
}

function escapeAttribute(value: string): string {
	return value.replace(ATTRIBUTE_ESCAPE_PATTERN, (c) => ATTRIBUTE_ESCAPES[c] ?? c);
}
