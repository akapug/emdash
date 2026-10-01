import sanitizeHtml from "sanitize-html";

import { isIframeHostname } from "./iframe-hosts.js";

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
 * Trimmed and lowercased, and kept only when it names exactly one host (see
 * `isIframeHostname`): a wildcard, a scheme, a port, a path or a non-string is
 * ignored, never widened into something that matches more.
 */
function normalizeHostnames(hostnames: Iterable<unknown>): string[] {
	const out: string[] = [];
	for (const raw of hostnames) {
		const host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
		if (isIframeHostname(host)) out.push(host);
	}
	return out;
}

/**
 * Add iframe hosts the renderer must not strip.
 *
 * Additive on purpose — the defaults cannot be removed by configuration, so a
 * misconfigured site can never end up allowing LESS than it did before. Call
 * this from an integration or a plugin's setup hook.
 */
export function configureIframeHostnames(hostnames: Iterable<string>): void {
	configuredHostnames = [...new Set([...configuredHostnames, ...normalizeHostnames(hostnames)])];
}

/** Test seam: forget everything `configureIframeHostnames` was given. */
export function resetIframeHostnames(): void {
	configuredHostnames = [];
}

function addedHostnames(): string[] {
	const fromEnv =
		typeof process !== "undefined" && typeof process.env?.EMDASH_IFRAME_HOSTNAMES === "string"
			? normalizeHostnames(process.env.EMDASH_IFRAME_HOSTNAMES.split(","))
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
 * sanitize-html's own reading of an iframe src (its `parseUrl`): the same
 * slash and whitespace folding, the same refusal of a `relative:` src, and a
 * `relative:` base, so the host decided here is the host sanitize-html checks
 * after it. A protocol-relative src comes back with the `relative:` protocol.
 */
const SLASH_FOLD = /^(\w+:)?\s*[\\/]\s*[\\/]/;
const RELATIVE_BASE = "relative://relative-site/";
const DEFAULT_HOST_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:", "relative:"]);
const LINK_TEXT_MAX = 200;

function parseIframeSrc(src: string): URL | undefined {
	const value = src.replace(SLASH_FOLD, "$1//");
	if (value.startsWith("relative:") || !URL.canParse(value, RELATIVE_BASE)) return undefined;
	return new URL(value, RELATIVE_BASE);
}

/** Where a link to a refused iframe goes: an absolute http(s) URL, or a protocol-relative one as https. */
function linkTarget(src: string, url: URL): URL | undefined {
	if (url.protocol === "https:" || url.protocol === "http:") return url;
	const value = src.replace(SLASH_FOLD, "$1//");
	if (url.protocol !== "relative:" || !value.startsWith("//")) return undefined;
	const https = `https:${value}`;
	return URL.canParse(https) ? new URL(https) : undefined;
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
 * added host and its src is https. Any other iframe with an http(s) src is
 * drawn as a link to that src, titled with the iframe's title or "Open the
 * embedded content" and the host, so a refused map is a link, never an empty
 * box. An iframe with no usable src (none, relative, `javascript:`) is removed.
 *
 * A `<noscript>` goes whole, with everything in it, as a `<script>` or a
 * `<style>` does: the browser draws what it holds only with scripts off, and
 * the page runs scripts. Unwrapped (sanitize-html's default for a tag it does
 * not allow), a pasted embed's "turn on JavaScript" line was drawn as text,
 * and a tracking pixel's `<img>` loaded on every page view.
 */
export function sanitizeContent(html: string, options: SanitizeOptions = {}): string {
	const perCall = Array.isArray(options.allowedIframeHostnames)
		? normalizeHostnames(options.allowedIframeHostnames)
		: [];
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
			iframe: (tagName, attribs) => {
				const src = attribs.src ?? "";
				const url = parseIframeSrc(src);
				if (!url) return { tagName, attribs: {} };
				const host = url.hostname;
				if (DEFAULT_HOSTS.has(host) && DEFAULT_HOST_PROTOCOLS.has(url.protocol)) {
					return { tagName, attribs };
				}
				if (added.has(host) && url.protocol === "https:") return { tagName, attribs };
				const link = linkTarget(src, url);
				if (!link) return { tagName, attribs: {} };
				warnRefused(link.hostname, allowed);
				const title = (attribs.title ?? "").trim().slice(0, LINK_TEXT_MAX);
				return {
					tagName: "a",
					attribs: { href: link.href, class: "emdash-iframe-link" },
					text: title || `Open the embedded content (${link.hostname})`,
				};
			},
		},
		// An iframe left with no src (refused above, or by sanitize-html's own
		// host and scheme checks) goes whole, so it never draws an empty box.
		exclusiveFilter: (frame) => frame.tag === "iframe" && !frame.attribs.src && !frame.attribs.href,
	});
}
