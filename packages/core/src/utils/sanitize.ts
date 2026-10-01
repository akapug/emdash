import sanitizeHtml from "sanitize-html";

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

let configuredHostnames: string[] = [];

/** Hostnames only: no scheme, no path, no wildcard (sanitize-html matches exactly). */
function normalizeHostnames(hostnames: Iterable<string>): string[] {
	const out: string[] = [];
	for (const raw of hostnames) {
		const host = raw.trim().toLowerCase();
		if (host.length === 0 || host.includes("/") || host.includes(":")) continue;
		out.push(host);
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

/**
 * The effective allowlist: the defaults, plus `EMDASH_IFRAME_HOSTNAMES`
 * (comma-separated), plus anything registered through
 * `configureIframeHostnames`.
 *
 * The environment variable is read on every call rather than cached, so a host
 * that runs one build for many sites can vary it per process.
 */
export function getAllowedIframeHostnames(): string[] {
	const fromEnv =
		typeof process !== "undefined" && typeof process.env?.EMDASH_IFRAME_HOSTNAMES === "string"
			? normalizeHostnames(process.env.EMDASH_IFRAME_HOSTNAMES.split(","))
			: [];
	return [...new Set([...DEFAULT_ALLOWED_IFRAME_HOSTNAMES, ...fromEnv, ...configuredHostnames])];
}

const IFRAME_TAG = /<iframe\b[^>]{0,4000}>/gi;
const IFRAME_SRC = /\bsrc\s*=\s*["']([^"']{0,2000})["']/i;
const warnedHostnames = new Set<string>();

/**
 * Say something the first time a host is dropped.
 *
 * A stripped iframe leaves no trace: no error, no log, and the block still
 * renders as an empty div. One warning per host per process is enough to turn
 * "the map disappeared" into a one-line fix.
 */
function warnAboutDroppedIframes(html: string, allowed: readonly string[]): void {
	for (const tag of html.match(IFRAME_TAG) ?? []) {
		const src = IFRAME_SRC.exec(tag)?.[1];
		if (!src) continue;
		let hostname: string;
		try {
			hostname = new URL(src, "https://example.invalid").hostname.toLowerCase();
		} catch {
			continue;
		}
		if (allowed.includes(hostname) || warnedHostnames.has(hostname)) continue;
		warnedHostnames.add(hostname);
		console.warn(
			`[emdash] Removed an iframe from "${hostname}": it is not in the allowed iframe hostnames ` +
				`(${allowed.join(", ")}). Add it with EMDASH_IFRAME_HOSTNAMES or configureIframeHostnames().`,
		);
	}
}

export interface SanitizeOptions {
	/**
	 * Replaces the effective allowlist for this call. Omit to use the defaults
	 * plus whatever the site configured.
	 */
	allowedIframeHostnames?: readonly string[];
}

/**
 * Sanitize HTML content to prevent XSS attacks.
 *
 * Allows standard formatting tags, images, iframes (from allowed providers),
 * and basic attributes.
 *
 * A `<noscript>` goes whole, with everything in it, as a `<script>` or a
 * `<style>` does: the browser draws what it holds only with scripts off, and
 * the page runs scripts. Unwrapped (sanitize-html's default for a tag it does
 * not allow), a pasted embed's "turn on JavaScript" line was drawn as text,
 * and a tracking pixel's `<img>` loaded on every page view.
 */
export function sanitizeContent(html: string, options: SanitizeOptions = {}): string {
	const allowedIframeHostnames = options.allowedIframeHostnames
		? normalizeHostnames(options.allowedIframeHostnames)
		: getAllowedIframeHostnames();
	if (html.includes("<iframe")) warnAboutDroppedIframes(html, allowedIframeHostnames);
	return sanitizeHtml(html, {
		allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "span", "iframe"],
		nonTextTags: ["script", "style", "textarea", "option", "noscript"],
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			"*": ["class", "id", "data-*"],
			iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen"],
			img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
		},
		allowedIframeHostnames: [...allowedIframeHostnames],
	});
}
