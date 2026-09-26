/**
 * WordPress autoembed
 *
 * WordPress keeps a classic embed as a bare URL in the post and turns it into
 * a player only when the post renders. This finds the URLs it turns into
 * players, following WP_Embed::autoembed() and the [embed] shortcode in
 * wp-includes/class-wp-embed.php.
 */

import { parseFragment } from "parse5";

import { decodeUrlEntities } from "./inline.js";
import { detectProvider } from "./provider.js";
import type { PortableTextBlock } from "./types.js";
import { sanitizeHref } from "./url.js";

// A URL alone on its line, or alone in a paragraph (where an [embed] shortcode may stand in for it).
// Only "\n" ends a line, as in WordPress, and no run of attributes reaches past the next
// bracket, so a match never rescans the text after a failed start.
const URL_LINE_PATTERN = /(?<![^\n])([^\S\n]*)(https?:\/\/[^\s<>"]+)[^\S\n]*(?![^\n])/gi;
const URL_PARAGRAPH_PATTERN =
	/<p(?: [^<>]*)?>\s*(https?:\/\/[^\s<>"]+|\[embed(?:\s[^[\]]*)?\][^[]*\[\/embed\])\s*<\/p>/gi;
const EMBED_SHORTCODE_PATTERN = /(?<!\[)\[embed(?:\s[^[\]]*)?\][^[]*\[\/embed\](?!\])/gi;
const EMBED_SHORTCODE_URL_PATTERN =
	/^\[embed(?:\s[^[\]]*)?\]\s*(https?:\/\/[^\s<>"]+)\s*\[\/embed\]$/i;
// A comment or a tag, split as wp_html_split() does: each runs to its end or to the end of the HTML
const HTML_TAG_PATTERN = /<!(?=--)(?:-(?!->)[^-]*)*(?:-->)?|<[^>]*>?/g;

// The default embed handlers, from wp_maybe_load_embeds() in wp-includes/embed.php
const YOUTUBE_EMBED_URL_PATTERN = /^https?:\/\/(www\.)?youtube\.com\/(?:v|embed)\/([^/]+)/i;
const AUDIO_FILE_PATTERN = /^https?:\/\/.+?\.(mp3|ogg|flac|m4a|wav)$/i;
const VIDEO_FILE_PATTERN = /^https?:\/\/.+?\.(mp4|m4v|webm|ogv|flv)$/i;

// The oEmbed providers, from WP_oEmbed::__construct() in wp-includes/class-wp-oembed.php
const OEMBED_PROVIDER_PATTERNS = [
	/^https?:\/\/((m|www)\.)?youtube\.com\/watch.*/i,
	/^https?:\/\/((m|www)\.)?youtube\.com\/playlist.*/i,
	/^https?:\/\/((m|www)\.)?youtube\.com\/shorts\/*/i,
	/^https?:\/\/((m|www)\.)?youtube\.com\/live\/*/i,
	/^https?:\/\/youtu\.be\/.*/i,
	/^https?:\/\/(.+\.)?vimeo\.com\/.*/i,
	/^https?:\/\/(www\.)?dailymotion\.com\/.*/i,
	/^https?:\/\/dai\.ly\/.*/i,
	/^https?:\/\/(www\.)?flickr\.com\/.*/i,
	/^https?:\/\/flic\.kr\/.*/i,
	/^https?:\/\/(.+\.)?smugmug\.com\/.*/i,
	/^https?:\/\/(www\.)?scribd\.com\/(doc|document)\/.*/i,
	/^https?:\/\/wordpress\.tv\/.*/i,
	/^https?:\/\/(.+\.)?crowdsignal\.net\/.*/i,
	/^https?:\/\/(.+\.)?polldaddy\.com\/.*/i,
	/^https?:\/\/poll\.fm\/.*/i,
	/^https?:\/\/(.+\.)?survey\.fm\/.*/i,
	/^https?:\/\/(www\.)?twitter\.com\/\w{1,15}\/status(es)?\/.*/i,
	/^https?:\/\/(www\.)?twitter\.com\/\w{1,15}$/i,
	/^https?:\/\/(www\.)?twitter\.com\/\w{1,15}\/likes$/i,
	/^https?:\/\/(www\.)?twitter\.com\/\w{1,15}\/lists\/.*/i,
	/^https?:\/\/(www\.)?twitter\.com\/\w{1,15}\/timelines\/.*/i,
	/^https?:\/\/(www\.)?twitter\.com\/i\/moments\/.*/i,
	/^https?:\/\/(www\.)?soundcloud\.com\/.*/i,
	/^https?:\/\/(open|play)\.spotify\.com\/.*/i,
	/^https?:\/\/(.+\.)?imgur\.com\/.*/i,
	/^https?:\/\/(www\.)?issuu\.com\/.+\/docs\/.+/i,
	/^https?:\/\/(www\.)?mixcloud\.com\/.*/i,
	/^https?:\/\/(www\.|embed\.)?ted\.com\/talks\/.*/i,
	/^https?:\/\/(www\.)?(animoto|video214)\.com\/play\/.*/i,
	/^https?:\/\/(.+)\.tumblr\.com\/.*/i,
	/^https?:\/\/(www\.)?kickstarter\.com\/projects\/.*/i,
	/^https?:\/\/kck\.st\/.*/i,
	/^https?:\/\/cloudup\.com\/.*/i,
	/^https?:\/\/((legacy|www)\.)?reverbnation\.com\/.*/i,
	/^https?:\/\/videopress\.com\/v\/.*/,
	/^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/.*/i,
	/^https?:\/\/(www\.)?speakerdeck\.com\/.*/i,
	/^https?:\/\/([a-z0-9-]+\.)?amazon\.(com|com\.mx|com\.br|ca)\/.*/i,
	/^https?:\/\/([a-z0-9-]+\.)?amazon\.(co\.uk|de|fr|it|es|in|nl|ru)\/.*/i,
	/^https?:\/\/([a-z0-9-]+\.)?amazon\.(co\.jp|com\.au)\/.*/i,
	/^https?:\/\/([a-z0-9-]+\.)?amazon\.cn\/.*/i,
	/^https?:\/\/(www\.)?a\.co\/.*/i,
	/^https?:\/\/(www\.)?amzn\.to\/.*/i,
	/^https?:\/\/(www\.)?amzn\.eu\/.*/i,
	/^https?:\/\/(www\.)?amzn\.in\/.*/i,
	/^https?:\/\/(www\.)?amzn\.asia\/.*/i,
	/^https?:\/\/(www\.)?z\.cn\/.*/i,
	/^https?:\/\/(www\.)?tiktok\.com\/.*\/video\/.*/i,
	/^https?:\/\/(www\.)?tiktok\.com\/@.*/i,
	/^https?:\/\/([a-z]{2}|www)\.pinterest\.com(\.(au|mx))?\/.*/i,
	/^https?:\/\/(www\.)?wolframcloud\.com\/obj\/.+/i,
	/^https?:\/\/pca\.st\/.+/i,
	/^https?:\/\/((play|www)\.)?anghami\.com\/.*/i,
	/^https?:\/\/bsky.app\/profile\/.*\/post\/.*/i,
	/^https?:\/\/(www\.)?canva\.com\/design\/.*\/view.*/i,
];

/**
 * A URL that WordPress replaces when it renders the post
 */
export interface Autoembed {
	/** Offset of the replaced markup in the searched HTML */
	start: number;
	/** Offset just past the replaced markup */
	end: number;
	url: string;
	/** False for an [embed] URL with no embed handler or provider: WordPress links it instead */
	embeddable: boolean;
}

/**
 * Find the URLs in classic HTML that WordPress replaces with an embed when
 * it renders the post, in document order and without overlaps.
 */
export function findAutoembeds(html: string): Autoembed[] {
	// A newline inside a tag does not end a line, and a shortcode inside a tag is not run
	const text = html.replace(HTML_TAG_PATTERN, (tag) => "<".repeat(tag.length));
	const found: Autoembed[] = [];

	for (const match of text.matchAll(URL_LINE_PATTERN)) {
		const [, indent = "", url = ""] = match;
		const start = match.index + indent.length;
		pushAutoembed(found, url, start, start + url.length);
	}
	for (const match of html.matchAll(URL_PARAGRAPH_PATTERN)) {
		pushAutoembed(found, match[1] ?? "", match.index, match.index + match[0].length);
	}
	for (const match of text.matchAll(EMBED_SHORTCODE_PATTERN)) {
		pushAutoembed(found, match[0], match.index, match.index + match[0].length);
	}

	const autoembeds: Autoembed[] = [];
	for (const autoembed of found.toSorted((a, b) => a.start - b.start)) {
		if (autoembed.start >= (autoembeds.at(-1)?.end ?? 0)) {
			autoembeds.push(autoembed);
		}
	}
	return autoembeds;
}

/**
 * The autoembeds in `html` that no element holds, other than a paragraph that is
 * the autoembed itself. The HTML around them can be cut away intact.
 */
export function findTopLevelAutoembeds(html: string): Autoembed[] {
	const autoembeds = findAutoembeds(html);
	if (autoembeds.length === 0) return autoembeds;

	const nodes = parseFragment(html, { sourceCodeLocationInfo: true }).childNodes;
	return autoembeds.filter((autoembed) => {
		const holders = nodes.filter(
			(node) =>
				node.nodeName !== "#text" &&
				(node.sourceCodeLocation?.startOffset ?? 0) < autoembed.end &&
				autoembed.start < (node.sourceCodeLocation?.endOffset ?? html.length),
		);
		const [holder] = holders;
		return (
			!holder ||
			(holders.length === 1 &&
				holder.nodeName === "p" &&
				holder.sourceCodeLocation?.startOffset === autoembed.start &&
				holder.sourceCodeLocation.endOffset === autoembed.end)
		);
	});
}

/**
 * The autoembed that makes up the whole of `html`, if there is one
 */
export function findSoleAutoembed(html: string): Autoembed | undefined {
	const [autoembed] = findAutoembeds(html);
	if (autoembed && !html.slice(0, autoembed.start).trim() && !html.slice(autoembed.end).trim()) {
		return autoembed;
	}
	return undefined;
}

/**
 * The block WordPress renders in place of an autoembed
 */
export function autoembedBlock(autoembed: Autoembed, generateKey: () => string): PortableTextBlock {
	const { url } = autoembed;

	if (autoembed.embeddable) {
		return {
			_type: "embed",
			_key: generateKey(),
			url,
			provider: embedProvider(url),
		};
	}

	const linkKey = generateKey();
	return {
		_type: "block",
		_key: generateKey(),
		style: "normal",
		children: [{ _type: "span", _key: generateKey(), text: url, marks: [linkKey] }],
		markDefs: [{ _type: "link", _key: linkKey, href: sanitizeHref(url) }],
	};
}

/**
 * Record `markup` (a URL or an [embed] shortcode) if WordPress replaces it
 */
function pushAutoembed(found: Autoembed[], markup: string, start: number, end: number): void {
	const isShortcode = markup.startsWith("[");
	const rawUrl = isShortcode ? EMBED_SHORTCODE_URL_PATTERN.exec(markup)?.[1] : markup;
	if (!rawUrl) return;

	const url = decodeUrlEntities(rawUrl);
	const embeddable = isEmbeddable(url);

	// Outside [embed], WordPress leaves a URL it cannot embed exactly as written
	if (embeddable || isShortcode) {
		found.push({ start, end, url, embeddable });
	}
}

function isEmbeddable(url: string): boolean {
	return (
		YOUTUBE_EMBED_URL_PATTERN.test(url) ||
		AUDIO_FILE_PATTERN.test(url) ||
		VIDEO_FILE_PATTERN.test(url) ||
		OEMBED_PROVIDER_PATTERNS.some((pattern) => pattern.test(url))
	);
}

function embedProvider(url: string): string | undefined {
	if (AUDIO_FILE_PATTERN.test(url)) return "audio";
	if (VIDEO_FILE_PATTERN.test(url)) return "video";
	return detectProvider(url);
}
