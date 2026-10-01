/**
 * One exact hostname a site may embed iframes from: lowercase dot-separated
 * labels of letters, digits and inner hyphens, ending in a letter TLD or an
 * IDN (`xn--`) TLD. No scheme, port, path, wildcard, userinfo, IP address,
 * `localhost` or trailing dot, so the value can only ever name one host and an
 * exact hostname match is the whole check.
 */
const IFRAME_HOSTNAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Domains no site may add a host under, whatever its setting says: the shared
 * Cloudflare domains every Worker and Pages project is served from, and the
 * launch platform's own domain, where tenants' preview hosts live. An iframe
 * from one of them is somebody's site served from a host we do not vouch for,
 * or one of our own.
 */
export const RESERVED_IFRAME_HOST_DOMAINS = ["workers.dev", "pages.dev", "embarkeasy.com"] as const;

/** `host` is `domain` or a subdomain of it. */
export const isUnderDomain = (host: string, domain: string): boolean =>
	host === domain || host.endsWith(`.${domain}`);

export function isIframeHostname(value: unknown): value is string {
	return (
		typeof value === "string" &&
		IFRAME_HOSTNAME.test(value) &&
		!RESERVED_IFRAME_HOST_DOMAINS.some((domain) => isUnderDomain(value, domain))
	);
}

/**
 * `hosts` without the site's own: a host that is one of `siteHosts` (or its
 * www-less form) or a subdomain of it. An iframe from the site's own origin
 * runs as the site, with its session, so it is never allowed by a list.
 */
const LEADING_WWW = /^www\./;

export function withoutSiteHosts(
	hosts: readonly string[],
	siteHosts: readonly (string | undefined)[],
): string[] {
	const own = siteHosts.flatMap((h) => (h ? [h.toLowerCase().replace(LEADING_WWW, "")] : []));
	return hosts.filter((host) => !own.some((domain) => isUnderDomain(host, domain)));
}
