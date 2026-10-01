/**
 * One exact hostname a site may embed iframes from: lowercase dot-separated
 * labels of letters, digits and inner hyphens, ending in a letter TLD or an
 * IDN (`xn--`) TLD. No scheme, port, path, wildcard, userinfo, IP address or
 * trailing dot, so the value can only ever name one host and sanitize-html's
 * exact hostname match is the whole check.
 */
const IFRAME_HOSTNAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function isIframeHostname(value: unknown): value is string {
	return typeof value === "string" && IFRAME_HOSTNAME.test(value);
}
