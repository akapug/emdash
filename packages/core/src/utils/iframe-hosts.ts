/**
 * One exact hostname a site may embed iframes from: lowercase dot-separated
 * labels of letters, digits and inner hyphens, ending in a letter TLD or an
 * IDN (`xn--`) TLD. No scheme, port, path, wildcard, userinfo, IP address,
 * `localhost` or trailing dot, so the value can only ever name one host and an
 * exact hostname match is the whole check.
 */
const IFRAME_HOSTNAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/;

/**
 * Domains no site may add a host under, whatever its setting says: the shared
 * Cloudflare domains every Worker and Pages project is served from, and the
 * launch platform's own domain, where tenants' preview hosts live. An iframe
 * from one of them is somebody's site served from a host we do not vouch for,
 * or one of our own.
 */
export const RESERVED_IFRAME_HOST_DOMAINS = ["workers.dev", "pages.dev", "embarkeasy.com"] as const;

/**
 * WordPress.com platform chrome: page furniture WordPress.com draws in an
 * iframe from its widget host, which works only on a WordPress.com page (a
 * Likes button reads the reader's WordPress.com login). A post copied from a
 * rendered WordPress.com page carries it; on any other site it is neither an
 * embed nor a link to one, so it is dropped. Only what was measured on real
 * posts is here: the Likes button (`widgets.wp.com/likes/`); a WordPress.com
 * host that serves content (VideoPress, a media embed) is not chrome. The
 * WordPress import drops the same iframes (gutenberg-to-portable-text
 * `iframe.ts`), so this covers content imported before it did, and one pasted
 * into an HTML block.
 */
const PLATFORM_CHROME: ReadonlyArray<readonly [host: string, path: RegExp]> = [
	["widgets.wp.com", /^\/likes(?:\/|$)/],
];

/** `url` is WordPress.com platform chrome (PLATFORM_CHROME). */
export const isPlatformChrome = (url: URL): boolean =>
	PLATFORM_CHROME.some(([host, path]) => url.hostname === host && path.test(url.pathname));

/** `host` is `domain` or a subdomain of it. */
export const isUnderDomain = (host: string, domain: string): boolean =>
	host === domain || host.endsWith(`.${domain}`);

export function isIframeHostname(value: unknown): value is string {
	return (
		typeof value === "string" &&
		// Exactly its trimmed self: a reader that trims and lowercases must never turn a refused
		// entry (" host", "host\n") into an accepted one. The anchored pattern already refuses
		// those (a JS `$` without the m flag is the end of the input); this says it outright.
		value === value.trim() &&
		IFRAME_HOSTNAME.test(value) &&
		!RESERVED_IFRAME_HOST_DOMAINS.some((domain) => isUnderDomain(value, domain))
	);
}

/**
 * The one canonical form of a list of iframe hosts, for every reader (the
 * render-side settings reader, the sanitizer, the env var and
 * `configureIframeHostnames`): each entry trimmed and lowercased, kept only when
 * it is then exactly one host (`isIframeHostname`), duplicates dropped. A value
 * that is not a list, and an entry that is not a string, give nothing. A stored
 * row is read through this whatever wrote it, schema or not.
 */
export function canonicalIframeHosts(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const hosts = value.map((raw) => (typeof raw === "string" ? raw.trim().toLowerCase() : ""));
	return [...new Set(hosts.filter(isIframeHostname))];
}

/**
 * `hosts` without the site's own: a host that is one of `siteHosts` (or its
 * www-less form) or a subdomain of it, both sides compared lowercased. An iframe from the site's own origin
 * runs as the site, with its session, so it is never allowed by a list.
 */
const LEADING_WWW = /^www\./;

export function withoutSiteHosts(
	hosts: readonly string[],
	siteHosts: readonly (string | undefined)[],
): string[] {
	const own = siteHosts.flatMap((h) => (h ? [h.toLowerCase().replace(LEADING_WWW, "")] : []));
	return hosts.filter((host) => !own.some((domain) => isUnderDomain(host.toLowerCase(), domain)));
}
