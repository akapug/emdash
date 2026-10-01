import sanitizeHtml from "sanitize-html";

import { canonicalIframeHosts, isPlatformChrome } from "./iframe-hosts.js";

/**
 * Iframe hosts allowed out of the box.
 *
 * Everything else used to be stripped with no way to change it, which meant a
 * site that embedded Google Maps, Calendly, SoundCloud, Spotify, Wistia,
 * Typeform, `youtube-nocookie.com` or even `youtu.be` lost those blocks at
 * render time — silently, with the block still present in the database and
 * still looking correct in the editor.
 */
export const DEFAULT_ALLOWED_IFRAME_HOSTNAMES = ["www.youtube.com", "player.vimeo.com"] as const;

const DEFAULT_HOSTS: ReadonlySet<string> = new Set(DEFAULT_ALLOWED_IFRAME_HOSTNAMES);

let configuredHostnames: string[] = [];

/**
 * Add iframe hosts the renderer must not strip.
 *
 * Additive on purpose — the defaults cannot be removed by configuration, so a
 * misconfigured site can never end up allowing LESS than it did before. Call
 * this from an integration or a plugin's setup hook.
 */
export function configureIframeHostnames(hostnames: Iterable<string>): void {
	configuredHostnames = [
		...new Set([...configuredHostnames, ...canonicalIframeHosts([...hostnames])]),
	];
}

/** Test seam: forget everything `configureIframeHostnames` was given. */
export function resetIframeHostnames(): void {
	configuredHostnames = [];
}

function addedHostnames(): string[] {
	const fromEnv =
		typeof process !== "undefined" && typeof process.env?.EMDASH_IFRAME_HOSTNAMES === "string"
			? canonicalIframeHosts(process.env.EMDASH_IFRAME_HOSTNAMES.split(","))
			: [];
	return [...fromEnv, ...configuredHostnames];
}

/**
 * The effective allowlist: the defaults, plus `EMDASH_IFRAME_HOSTNAMES`
 * (comma-separated), plus anything registered through
 * `configureIframeHostnames`.
 *
 * The environment variable is read on every call rather than cached, so a host
 * that runs one build for many sites can vary it per process.
 */
export function getAllowedIframeHostnames(): string[] {
	return [...new Set([...DEFAULT_ALLOWED_IFRAME_HOSTNAMES, ...addedHostnames()])];
}

/**
 * How the browser reads an iframe src, read strictly, and the one reading
 * every iframe decision here is made on.
 *
 * The raw value, trimmed as the browser trims it, is refused outright when it
 * holds a backslash, whitespace or a control character. A browser folds those
 * (in an https URL a backslash is a slash, and a tab or newline is dropped),
 * and sanitize-html's own check reads a protocol-relative src against a
 * non-special `relative:` base, where `//evil.example\@www.youtube.com/x`
 * names www.youtube.com while the browser loads evil.example. What is left is
 * parsed as an absolute URL, or as https when it is protocol-relative; a
 * path-relative src is refused (no host to allow).
 */
const UNSAFE_SRC_CHAR = /[\\\s\p{Cc}]/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINK_TEXT_MAX = 200;

interface IframeSrc {
	url: URL;
	protocolRelative: boolean;
}

function readIframeSrc(src: string): IframeSrc | undefined {
	const raw = src.trim();
	if (UNSAFE_SRC_CHAR.test(raw)) return undefined;
	const protocolRelative = raw.startsWith("//");
	const absolute = protocolRelative ? `https:${raw}` : raw;
	if (!SCHEME.test(absolute) || !URL.canParse(absolute)) return undefined;
	const url = new URL(absolute);
	return url.protocol === "https:" || url.protocol === "http:"
		? { url, protocolRelative }
		: undefined;
}

/**
 * What becomes of one iframe src, from that one reading: kept as an iframe of
 * `url` (YouTube and Vimeo as before; an added host only over https, never
 * protocol-relative), drawn as a link to `url`, or removed (no reading, or
 * WordPress.com platform chrome, which is no embed and links nowhere useful). Both
 * gates ask this: the transform that draws the iframe or the link, and the
 * filter that re-reads the src it drew.
 */
type IframeVerdict = { keep: boolean; url: URL } | undefined;

function iframeVerdict(src: string, added: ReadonlySet<string>): IframeVerdict {
	const read = readIframeSrc(src);
	if (!read || isPlatformChrome(read.url)) return undefined;
	const { url, protocolRelative } = read;
	const keep =
		DEFAULT_HOSTS.has(url.hostname) ||
		(added.has(url.hostname) && url.protocol === "https:" && !protocolRelative);
	return { keep, url };
}

const warnedHostnames = new Set<string>();

/**
 * Say something the first time a host is refused, once per host per process,
 * so "the map turned into a link" is a one-line fix.
 */
function warnRefused(hostname: string, allowed: readonly string[]): void {
	if (warnedHostnames.has(hostname)) return;
	warnedHostnames.add(hostname);
	console.warn(
		`[emdash] An iframe from "${hostname}" is drawn as a link: it is not in the allowed iframe ` +
			`hostnames (${allowed.join(", ")}), or it is but its src is not https. Add it to the site's ` +
			`iframeHosts setting, EMDASH_IFRAME_HOSTNAMES or configureIframeHostnames().`,
	);
}

export interface SanitizeOptions {
	/**
	 * More iframe hosts for this call, such as the site's `iframeHosts`
	 * setting. Added to the defaults, `EMDASH_IFRAME_HOSTNAMES` and
	 * `configureIframeHostnames()`, never in place of them. Entries that do not
	 * name exactly one host are ignored.
	 */
	allowedIframeHostnames?: readonly string[];
}

/**
 * Sanitize HTML content to prevent XSS attacks.
 *
 * Allows standard formatting tags, images, iframes (from allowed providers),
 * and basic attributes.
 *
 * An iframe is kept when its host is YouTube's or Vimeo's (as before), or an
 * added host and its src is https (not protocol-relative); a kept iframe's src
 * is drawn as the URL the decision read. Any other iframe with an http(s) or
 * protocol-relative src is drawn as a link to that src, titled with the
 * iframe's title or "Open the embedded content" and the host, so a refused map
 * is a link, never an empty box. An iframe with no usable src (none,
 * path-relative, another scheme such as `javascript:`, or one holding a
 * backslash, whitespace or a control character) is removed, and so is
 * WordPress.com platform chrome (a Jetpack Likes button), whatever the lists say.
 *
 * A `<noscript>` goes whole, with everything in it, as a `<script>` or a
 * `<style>` does: the browser draws what it holds only with scripts off, and
 * the page runs scripts. Unwrapped (sanitize-html's default for a tag it does
 * not allow), a pasted embed's "turn on JavaScript" line was drawn as text,
 * and a tracking pixel's `<img>` loaded on every page view.
 */
export function sanitizeContent(html: string, options: SanitizeOptions = {}): string {
	const perCall = canonicalIframeHosts(options.allowedIframeHostnames);
	const added = new Set([...addedHostnames(), ...perCall].filter((h) => !DEFAULT_HOSTS.has(h)));
	const allowed = [...DEFAULT_HOSTS, ...added];
	return sanitizeHtml(html, {
		allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "span", "iframe"],
		nonTextTags: ["script", "style", "textarea", "option", "noscript"],
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			"*": ["class", "id", "data-*"],
			iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen", "title"],
			img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
		},
		allowedIframeHostnames: allowed,
		transformTags: {
			iframe: (tagName, attribs): sanitizeHtml.Tag => {
				const verdict = iframeVerdict(attribs.src ?? "", added);
				if (!verdict) return { tagName, attribs: {} };
				// The src drawn is the URL decided on, so the browser loads what was checked.
				if (verdict.keep) return { tagName, attribs: { ...attribs, src: verdict.url.href } };
				const host = verdict.url.hostname;
				warnRefused(host, allowed);
				const title = (attribs.title ?? "").trim().slice(0, LINK_TEXT_MAX);
				return {
					tagName: "a",
					attribs: { href: verdict.url.href, class: "emdash-iframe-link" },
					text: title || `Open the embedded content (${host})`,
				};
			},
		},
		// The second gate: an iframe still standing is re-read from the src it
		// drew, with the same reading, and goes whole (never an empty box) unless
		// that src is kept. sanitize-html's own host check stays as a third.
		exclusiveFilter: (frame) =>
			frame.tag === "iframe" &&
			frame.attribs.href === undefined &&
			iframeVerdict(frame.attribs.src ?? "", added)?.keep !== true,
	});
}
