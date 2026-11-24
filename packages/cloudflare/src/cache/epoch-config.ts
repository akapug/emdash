/**
 * Epoch-validated Cloudflare Cache API full-page cache provider — CONFIG ENTRY.
 *
 * Designed for custom domains and branded hosts where Workers Cache API is
 * active, without requiring zone REST purge tokens (`CF_ZONE_ID` /
 * `CF_CACHE_PURGE_TOKEN`) and without auto-enabling native Workers Caching.
 *
 * OFF by default per tenant unless the configured Worker env var
 * (`EMDASH_PAGE_CACHE` by default) is set to `"1"` or `"true"`.
 *
 * Safe to import at Astro config time (does NOT import `cloudflare:workers`).
 */

import type { CacheProviderConfig } from "astro";

export interface EpochCloudflareCacheConfig {
	/**
	 * Versioned Cache API namespace name.
	 * @default "emdash-page-v1"
	 */
	cacheName?: string;

	/**
	 * Worker environment variable name that enables page caching for a tenant.
	 * Must be `"1"` or `"true"` (case-insensitive) to activate; OFF by default.
	 * @default "EMDASH_PAGE_CACHE"
	 */
	enabledEnvVar?: string;

	/**
	 * Worker environment variable name carrying the operator-provisioned
	 * non-secret tenant/database-incarnation scope (e.g. `<d1Id>:<incarnationUuid>`).
	 * Required to activate caching so host reassignment, D1 replacement, or an
	 * OFF->ON toggle starts a fresh isolated Cache API namespace.
	 * @default "EMDASH_PAGE_CACHE_SCOPE"
	 */
	scopeEnvVar?: string;

	/**
	 * D1 binding name used for the authoritative primary-database visibility
	 * revision check on every HIT.
	 * @default "DB"
	 */
	d1Binding?: string;

	/**
	 * D1 bookmark cookie name allowed on anonymous requests and stripped only
	 * from the stored cache copy (never from the MISS response).
	 * @default "__em_d1_bookmark"
	 */
	bookmarkCookie?: string;

	/**
	 * Build timestamp or deployment identifier folded into the generation vector.
	 */
	buildId?: string;

	/**
	 * Timeout (ms) for the authoritative D1 primary visibility check.
	 * @default 2000
	 */
	visibilityTimeoutMs?: number;

	/**
	 * Explicitly disable page caching in playground deployments.
	 * @default false
	 */
	disabledWhenPlayground?: boolean;
}

export function epochCloudflareCache(
	config: EpochCloudflareCacheConfig = {},
): CacheProviderConfig<EpochCloudflareCacheConfig> {
	return {
		entrypoint: "@emdash-cms/cloudflare/cache/epoch",
		config,
	};
}
