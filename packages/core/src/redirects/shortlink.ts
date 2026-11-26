/**
 * WordPress shortlink query-string matching for redirect rules (item 159).
 *
 * WordPress prints `/?p=N`, `/?page_id=N`, and `/?attachment_id=N` as its
 * shortlinks and fallback permalinks, and shared links frequently carry
 * tracking query parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`)
 * beside the ID.
 *
 * This module defines the narrow, closed set of query-string forms the
 * redirect middleware resolves against exact redirect rows (`/?<key>=<id>`).
 * Any other query string returns `null` and remains unsupported.
 */

export const WP_SHORTLINK_CAPABILITY = "emdash.redirects-wp-shortlinks.v1" as const;

export const WP_SHORTLINK_KEYS = ["p", "page_id", "attachment_id"] as const;
export type WpShortlinkKey = (typeof WP_SHORTLINK_KEYS)[number];

const WP_SHORTLINK_KEY_SET: ReadonlySet<string> = new Set<string>(WP_SHORTLINK_KEYS);

/**
 * Named, reviewed set of tracking query keys allowed beside a WordPress
 * shortlink ID. Tracking parameters are ignored during lookup and dropped by
 * the redirect destination.
 */
export const WP_SHORTLINK_TRACKING_KEYS: ReadonlySet<string> = new Set([
	"fbclid",
	"gclid",
	"mc_cid",
	"mc_eid",
]);

const POSITIVE_INT = /^[1-9]\d*$/;
const UTM_PARAM = /^utm_[a-z0-9_]+$/i;

function isAllowedTrackingKey(key: string): boolean {
	return UTM_PARAM.test(key) || WP_SHORTLINK_TRACKING_KEYS.has(key.toLowerCase());
}

/**
 * Extract the canonical WordPress shortlink redirect key (`/?p=123`,
 * `/?page_id=45`, `/?attachment_id=500`) from an incoming request URL, or
 * `null` if the URL is not a supported WordPress shortlink.
 */
export function wpShortlinkKey(url: URL): string | null {
	if (url.pathname !== "/" || url.search.length === 0) return null;

	let foundKey: WpShortlinkKey | null = null;
	let foundId: string | null = null;

	for (const [key, value] of url.searchParams.entries()) {
		if (WP_SHORTLINK_KEY_SET.has(key)) {
			if (foundKey !== null) return null;
			if (!POSITIVE_INT.test(value)) return null;
			foundKey = key as WpShortlinkKey;
			foundId = value;
			continue;
		}
		if (isAllowedTrackingKey(key)) {
			continue;
		}
		return null;
	}

	if (foundKey === null || foundId === null) return null;
	return `/?${foundKey}=${foundId}`;
}
