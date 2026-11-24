/**
 * Epoch-validated Cloudflare Cache API full-page cache provider — RUNTIME ENTRY.
 *
 * Security & correctness invariants:
 * - OFF by default per tenant unless `env[enabledEnvVar]` is `"1"` or `"true"`.
 * - Distinct provider name `"emdash-epoch-cache"` (never `"cloudflare"`) so
 *   `@astrojs/cloudflare` does not auto-enable native Workers Caching.
 * - Positive public-route allowlist, exact HTTPS host + pathname key, ALL
 *   query strings and conditional/range requests bypassed in v1.
 * - Exact cookie-name allowlist (`__em_d1_bookmark`, `theme`); unknown or
 *   malformed cookies bypass.
 * - Explicit final positive opt-in (`optInPageCache(ttl)`) + irreversible
 *   per-request opt-out (`optOutPageCache()`), with the body stream drained
 *   INSIDE the request's ALS scope so genuinely async delayed streamed
 *   opt-outs stay sticky.
 * - Inspects BOTH Astro's real response cookie queue (`Symbol.for("astro.cookies")`
 *   via `.headers()`, never `.consume()`) AND raw `Set-Cookie` headers, and
 *   re-attaches `Symbol.for("astro.cookies")` onto any MISS/BYPASS wrapper
 *   Response so queued cookies are never dropped or consumed.
 * - Cache-fill renders set `fillPrimary: true` so D1 routes to `first-primary`
 *   and `objectCache` is bypassed, coupling stored bytes to the authoritative
 *   primary visibility revision.
 * - Separates authorization from freshness:
 *   - Authorization: authoritative D1 primary `emdash:visibility_rev` read
 *     from `options(name, value, revision)` on EVERY HIT (fail-closed, immune
 *     to KV 60s+ lag or KV outage).
 *   - Freshness: full ordered `objectCache` generation vector captured BEFORE
 *     render and re-verified AFTER stream completion (rejects storage on
 *     uncertainty or mid-render change; no SWR in v1).
 * - Stored Cache API copy carries explicit `Cache-Control: public, max-age=<ttl>`
 *   (so the real Cache API stores it even when origin carried `no-cache`),
 *   while client responses carry `Cache-Control: private, no-cache`.
 */

import type { CacheProvider, CacheProviderFactory } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import {
	CacheNamespace,
	getPageCacheState,
	invalidateObjectCache,
	invalidateWidgetObjectCache,
	PAGE_CACHE_MAX_TTL_SECONDS,
	PAGE_CACHE_MIN_TTL_SECONDS,
	readPageGenerationVector,
	runWithPageCacheState,
	VISIBILITY_REV_OPTION,
	type PageCacheAuthority,
	type PageGenerationVectorResult,
} from "emdash";

import type { EpochCloudflareCacheConfig } from "./epoch-config.js";

const DEFAULT_CACHE_NAME = "emdash-page-v1";
const DEFAULT_ENABLED_ENV_VAR = "EMDASH_PAGE_CACHE";
const DEFAULT_SCOPE_ENV_VAR = "EMDASH_PAGE_CACHE_SCOPE";
const DEFAULT_D1_BINDING = "DB";
const DEFAULT_BOOKMARK_COOKIE = "__em_d1_bookmark";
const DEFAULT_VISIBILITY_TIMEOUT_MS = 2000;
const VALID_SCOPE_RE = /^[a-zA-Z0-9:_-]{8,128}$/;

const ASTRO_COOKIES_SYMBOL = Symbol.for("astro.cookies");

const HEADER_SCOPE = "X-EmDash-Cache-Scope";
const HEADER_VECTOR = "X-EmDash-Page-Vector";
const HEADER_VISIBILITY_REV = "X-EmDash-Visibility-Rev";
const HEADER_STORED_AT = "X-EmDash-Stored-At";
const HEADER_TTL = "X-EmDash-Page-TTL";
const HEADER_STATUS = "X-Embark-Page-Cache";

const INTERNAL_HEADERS = [
	HEADER_SCOPE,
	HEADER_VECTOR,
	HEADER_VISIBILITY_REV,
	HEADER_STORED_AT,
	HEADER_TTL,
];

const CREDENTIAL_HEADERS = [
	"authorization",
	"proxy-authorization",
	"cf-access-jwt-assertion",
	"cf-access-authenticated-user-email",
	"cookie2",
];

const CONDITIONAL_OR_RANGE_HEADERS = [
	"if-none-match",
	"if-modified-since",
	"if-match",
	"if-unmodified-since",
	"if-range",
	"range",
];

const ALLOWED_CONTENT_TYPES = new Set([
	"text/html",
	"application/xml",
	"text/xml",
	"application/rss+xml",
	"text/plain",
]);

const PRIVATE_OR_NO_STORE_RE = /\b(?:private|no-store)\b/;
const MAX_AGE_ZERO_RE = /\bmax-age=0\b/;
const NON_ID_CHARS_RE = /[^a-zA-Z0-9_-]/g;

/** Positive allowlist of public, cache-eligible pathnames in v1. */
const ALLOWLIST_EXACT_PATHS = new Set([
	"/",
	"/posts",
	"/posts/",
	"/sitemap.xml",
	"/robots.txt",
	"/rss.xml",
]);

const ALLOWLIST_PATH_PATTERNS = [
	/^\/posts\/[a-z0-9][a-z0-9-]{0,199}\/?$/,
	/^\/pages\/[a-z0-9][a-z0-9-]{0,199}\/?$/,
	/^\/category\/[a-z0-9][a-z0-9-]{0,199}\/?$/,
	/^\/tag\/[a-z0-9][a-z0-9-]{0,199}\/?$/,
	/^\/sitemap-[a-z][a-z0-9_]*\.xml$/,
];

export function isAllowlistedPublicPath(pathname: string): boolean {
	if (ALLOWLIST_EXACT_PATHS.has(pathname)) return true;
	return ALLOWLIST_PATH_PATTERNS.some((re) => re.test(pathname));
}

/**
 * Strict cookie-name allowlist check.
 * Returns `true` only when the Cookie header is empty/absent OR every pair is
 * well-formed (`name=value`) and its trimmed name is in `allowedNames`.
 */
export function hasOnlyAllowedCookies(
	cookieHeader: string | null,
	allowedNames: ReadonlySet<string>,
): boolean {
	if (!cookieHeader || cookieHeader.trim() === "") return true;
	const parts = cookieHeader.split(";");
	for (const part of parts) {
		const trimmed = part.trim();
		if (trimmed === "") return false;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) return false;
		const name = trimmed.slice(0, eq).trim();
		if (!name || !allowedNames.has(name)) return false;
	}
	return true;
}

export function isCacheEnabledFlag(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
}

function isAllowedContentType(header: string | null): boolean {
	if (!header) return false;
	const mime = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return ALLOWED_CONTENT_TYPES.has(mime);
}

function hasDisallowedCacheControl(response: Response): boolean {
	const cc = (response.headers.get("cache-control") ?? "").toLowerCase();
	if (PRIVATE_OR_NO_STORE_RE.test(cc)) return true;
	for (const hdr of ["cdn-cache-control", "cloudflare-cdn-cache-control"]) {
		const val = (response.headers.get(hdr) ?? "").toLowerCase();
		if (!val) continue;
		if (PRIVATE_OR_NO_STORE_RE.test(val) || MAX_AGE_ZERO_RE.test(val)) return true;
	}
	return false;
}

function hasNontrivialVary(response: Response): boolean {
	const vary = response.headers.get("vary");
	if (!vary) return false;
	const tokens = vary
		.split(",")
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	return tokens.some((t) => t !== "accept-encoding");
}

/**
 * Inspect Astro's real response cookie queue attached via `Symbol.for("astro.cookies")`
 * WITHOUT calling `.consume()`, so the adapter still emits every queued cookie.
 */
function readResponseQueuedCookies(response: Response): string[] {
	const jar = Reflect.get(response, ASTRO_COOKIES_SYMBOL) as
		| { headers?: () => Iterable<string> }
		| undefined;
	if (!jar || typeof jar.headers !== "function") return [];
	return [...jar.headers()];
}

/** Preserve Astro's `Symbol.for("astro.cookies")` queue when wrapping a Response. */
function preserveAstroCookies(source: Response, target: Response): Response {
	const jar = Reflect.get(source, ASTRO_COOKIES_SYMBOL);
	if (jar !== undefined) {
		Reflect.set(target, ASTRO_COOKIES_SYMBOL, jar);
	}
	return target;
}

function hasOnlyBookmarkSetCookies(cookies: readonly string[], bookmarkCookie: string): boolean {
	if (cookies.length === 0) return true;
	const prefix = `${bookmarkCookie}=`;
	return cookies.every((c) => c.trimStart().startsWith(prefix));
}

function stripInternalAndCdnHeaders(headers: Headers): void {
	for (const h of INTERNAL_HEADERS) headers.delete(h);
	headers.delete("cdn-cache-control");
	headers.delete("cloudflare-cdn-cache-control");
	headers.set("cache-control", "private, no-cache");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	if (!(ms > 0)) return promise;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`visibility check timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface D1Like {
	prepare(sql: string): {
		bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
	};
	withSession?(constraint: string): {
		prepare(sql: string): {
			bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
		};
	};
}

export interface EpochCacheRuntimeDeps {
	getEnv?: () => Record<string, unknown>;
	openCache?: (name: string) => Promise<Cache>;
	schedule?: (p: Promise<unknown>) => void;
	readVector?: (buildId?: string) => Promise<PageGenerationVectorResult>;
	readAuthority?: (d1Binding: string, timeoutMs: number) => Promise<PageCacheAuthority | null>;
	now?: () => number;
	/** Only for unit tests running against http:// URLs. */
	allowHttpForTests?: boolean;
}

/**
 * Authoritative primary-database read of `(activeIncarnation, visibilityRev)`
 * from `options(name, value, revision)` (migrations/001_initial.ts).
 * Returns `null` when absent, retired (`value = ''`), or on any DB/timeout error
 * so callers fail closed.
 */
export async function readPrimaryPageCacheAuthorityFromD1(
	d1: D1Like | undefined,
	timeoutMs: number,
): Promise<PageCacheAuthority | null> {
	if (!d1 || typeof d1.prepare !== "function") return null;
	try {
		const target = typeof d1.withSession === "function" ? d1.withSession("first-primary") : d1;
		const row = await withTimeout(
			target
				.prepare("SELECT value, revision FROM options WHERE name = ? LIMIT 1")
				.bind(VISIBILITY_REV_OPTION)
				.first<{ value?: string; revision?: string }>(),
			timeoutMs,
		);
		if (!row || !row.value || !row.revision) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(row.value));
		} catch {
			return null;
		}
		if (typeof parsed !== "string" || parsed.trim().length === 0) return null;
		return {
			activeIncarnation: parsed.trim(),
			visibilityRev: String(row.revision),
		};
	} catch {
		return null;
	}
}

export function resolvePageCacheScope(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return VALID_SCOPE_RE.test(trimmed) ? trimmed : null;
}

export function createEpochCacheProvider(
	config: EpochCloudflareCacheConfig = {},
	deps: EpochCacheRuntimeDeps = {},
): CacheProvider {
	const baseCacheName = config.cacheName ?? DEFAULT_CACHE_NAME;
	const buildId = config.buildId ?? "";
	const sanitizedBuild = buildId ? buildId.replace(NON_ID_CHARS_RE, "") : "";
	const enabledEnvVar = config.enabledEnvVar ?? DEFAULT_ENABLED_ENV_VAR;
	const scopeEnvVar = config.scopeEnvVar ?? DEFAULT_SCOPE_ENV_VAR;
	const d1Binding = config.d1Binding ?? DEFAULT_D1_BINDING;
	const bookmarkCookie = config.bookmarkCookie ?? DEFAULT_BOOKMARK_COOKIE;
	const visibilityTimeoutMs = config.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
	const disabledWhenPlayground = config.disabledWhenPlayground === true;

	const allowedCookies = new Set<string>([bookmarkCookie, "theme"]);
	const getEnv = deps.getEnv ?? (() => env as unknown as Record<string, unknown>);
	const openCache = deps.openCache ?? ((name: string) => caches.open(name));
	const schedule = deps.schedule ?? ((p: Promise<unknown>) => waitUntil(p));
	const readVector = deps.readVector ?? ((b?: string) => readPageGenerationVector(b));
	const now = deps.now ?? (() => Date.now());
	const readAuthority =
		deps.readAuthority ??
		((binding: string, timeoutMs: number) =>
			readPrimaryPageCacheAuthorityFromD1(getEnv()[binding] as D1Like | undefined, timeoutMs));

	const cacheNameForScope = (scope: string): string => {
		const safeScope = scope.replace(NON_ID_CHARS_RE, "");
		return sanitizedBuild
			? `${baseCacheName}-${safeScope}-${sanitizedBuild}`
			: `${baseCacheName}-${safeScope}`;
	};

	const isEligibleRequest = (request: Request, url: URL): boolean => {
		if (disabledWhenPlayground) return false;
		if (request.method !== "GET") return false;
		if (url.protocol !== "https:" && !(deps.allowHttpForTests && url.protocol === "http:")) {
			return false;
		}
		const host = url.host.toLowerCase();
		if (host.endsWith(".workers.dev") || host === "workers.dev") return false;
		if (url.search !== "") return false;
		if (!isAllowlistedPublicPath(url.pathname)) return false;

		for (const h of CREDENTIAL_HEADERS) {
			const val = request.headers.get(h);
			if (val !== null && val.trim() !== "") return false;
		}
		for (const h of CONDITIONAL_OR_RANGE_HEADERS) {
			if (request.headers.has(h)) return false;
		}
		if (!hasOnlyAllowedCookies(request.headers.get("cookie"), allowedCookies)) {
			return false;
		}
		return true;
	};

	const buildCacheKey = (url: URL): Request => {
		const scheme = deps.allowHttpForTests && url.protocol === "http:" ? "http" : "https";
		return new Request(`${scheme}://${url.host.toLowerCase()}${url.pathname}`, { method: "GET" });
	};

	return {
		// Distinct name: never "cloudflare" (which auto-enables native Workers Caching).
		name: "emdash-epoch-cache",

		async onRequest(context, next) {
			const envObj = getEnv();
			const scope = resolvePageCacheScope(envObj[scopeEnvVar]);
			if (!isCacheEnabledFlag(envObj[enabledEnvVar]) || scope === null) {
				return next();
			}

			const { request, url } = context;
			if (!isEligibleRequest(request, url)) {
				const bypass = await next();
				const out = preserveAstroCookies(bypass, new Response(bypass.body, bypass));
				out.headers.set(HEADER_STATUS, "BYPASS");
				return out;
			}

			const cacheName = cacheNameForScope(scope);
			let cache: Cache | null = null;
			try {
				cache = await openCache(cacheName);
			} catch {
				// Cache API unavailable: degrade cleanly to normal render.
				return next();
			}

			const key = buildCacheKey(url);
			const isAuthorityActive = (auth: PageCacheAuthority | null): auth is PageCacheAuthority =>
				auth !== null && auth.activeIncarnation === scope && auth.visibilityRev.length > 0;

			// Run cache lookup, strict generation vector read, and D1-primary
			// authoritative `(activeIncarnation, visibilityRev)` check in parallel
			// BEFORE rendering.
			const [cached, preVec, preAuth] = await Promise.all([
				cache.match(key).catch(() => undefined),
				readVector(buildId),
				readAuthority(d1Binding, visibilityTimeoutMs),
			]);

			// Fail closed if D1 primary has retired this incarnation, switched to a
			// newer incarnation, or is unreachable: an old ON Worker MUST NOT serve
			// retained copies or fill the cache.
			if (!isAuthorityActive(preAuth)) {
				const bypass = await next();
				const out = preserveAstroCookies(bypass, new Response(bypass.body, bypass));
				out.headers.set(HEADER_STATUS, "BYPASS");
				return out;
			}

			if (cached && preVec.certain) {
				const storedScope = cached.headers.get(HEADER_SCOPE);
				const storedVec = cached.headers.get(HEADER_VECTOR);
				const storedVis = cached.headers.get(HEADER_VISIBILITY_REV);
				const storedAt = Number.parseInt(cached.headers.get(HEADER_STORED_AT) ?? "0", 10);
				const storedTtl = Number.parseInt(cached.headers.get(HEADER_TTL) ?? "0", 10);
				const ageSeconds = (now() - storedAt) / 1000;

				if (
					storedScope === scope &&
					storedVec === preVec.vector &&
					storedVis === preAuth.visibilityRev &&
					storedTtl > 0 &&
					ageSeconds >= 0 &&
					ageSeconds < storedTtl
				) {
					const hit = new Response(cached.body, cached);
					stripInternalAndCdnHeaders(hit.headers);
					hit.headers.set(HEADER_STATUS, "HIT");
					return hit;
				}
			}

			// MISS (eligible cache fill): render AND drain the body stream INSIDE the
			// same `fillPrimary: true` ALS scope so:
			//  1. D1 routes reads to `first-primary` and `objectCache` is bypassed
			//     (coupling stored bytes to the authoritative primary visibility rev).
			//  2. Any genuinely async delayed streamed component calling
			//     `optOutPageCache()` executes inside the live ALS scope.
			const rendered = await runWithPageCacheState(
				async () => {
					const response = await next();
					const state = getPageCacheState();
					const basicChecksOk =
						preVec.certain &&
						response.status === 200 &&
						isAllowedContentType(response.headers.get("content-type")) &&
						!hasDisallowedCacheControl(response) &&
						!hasNontrivialVary(response);

					const rawSetCookies = response.headers.getSetCookie();
					const queuedCookies = readResponseQueuedCookies(response);
					const cookiesSafe =
						hasOnlyBookmarkSetCookies(rawSetCookies, bookmarkCookie) &&
						hasOnlyBookmarkSetCookies(queuedCookies, bookmarkCookie);

					if (!basicChecksOk || !cookiesSafe || !state || state.optedOut) {
						return { response, bodyBytes: null as ArrayBuffer | null, state };
					}

					// Drain body stream while STILL inside the ALS scope!
					const bodyBytes = await response.arrayBuffer();
					return { response, bodyBytes, state };
				},
				{ fillPrimary: true },
			);

			const { response, bodyBytes, state } = rendered;

			if (bodyBytes === null) {
				const miss = preserveAstroCookies(response, new Response(response.body, response));
				if (!hasDisallowedCacheControl(response)) {
					miss.headers.delete("cdn-cache-control");
					miss.headers.delete("cloudflare-cdn-cache-control");
				}
				miss.headers.set(HEADER_STATUS, "MISS");
				return miss;
			}

			// Re-check complete final header policy, irreversible opt-out, real
			// response cookie queue, and post-render generation vector + primary
			// authority AFTER stream drain (defense-in-depth).
			const finalRawSetCookies = response.headers.getSetCookie();
			const finalQueuedCookies = readResponseQueuedCookies(response);
			const finalHeadersOk =
				response.status === 200 &&
				isAllowedContentType(response.headers.get("content-type")) &&
				!hasDisallowedCacheControl(response) &&
				!hasNontrivialVary(response);
			const finalCookiesSafe =
				hasOnlyBookmarkSetCookies(finalRawSetCookies, bookmarkCookie) &&
				hasOnlyBookmarkSetCookies(finalQueuedCookies, bookmarkCookie);
			const finalEligible =
				finalHeadersOk &&
				finalCookiesSafe &&
				state !== undefined &&
				state.optedIn &&
				!state.optedOut &&
				state.ttlSeconds >= PAGE_CACHE_MIN_TTL_SECONDS;

			if (finalEligible) {
				const [postVec, postAuth] = await Promise.all([
					readVector(buildId),
					readAuthority(d1Binding, visibilityTimeoutMs),
				]);

				if (
					postVec.certain &&
					isAuthorityActive(postAuth) &&
					postVec.vector === preVec.vector &&
					postAuth.visibilityRev === preAuth.visibilityRev
				) {
					const ttl = Math.min(
						PAGE_CACHE_MAX_TTL_SECONDS,
						Math.max(PAGE_CACHE_MIN_TTL_SECONDS, state.ttlSeconds),
					);
					const storeHeaders = new Headers(response.headers);
					// Strip Set-Cookie ONLY on the stored copy (never on the MISS response).
					storeHeaders.delete("set-cookie");
					storeHeaders.delete("cdn-cache-control");
					storeHeaders.delete("cloudflare-cdn-cache-control");
					// Explicit max-age on the stored Cache API copy ONLY so Cloudflare
					// Cache API stores it even when the origin response had `no-cache`.
					storeHeaders.set("cache-control", `public, max-age=${ttl}`);
					storeHeaders.set(HEADER_SCOPE, scope);
					storeHeaders.set(HEADER_VECTOR, preVec.vector);
					storeHeaders.set(HEADER_VISIBILITY_REV, preAuth.visibilityRev);
					storeHeaders.set(HEADER_STORED_AT, String(now()));
					storeHeaders.set(HEADER_TTL, String(ttl));

					const toStore = new Response(bodyBytes, {
						status: response.status,
						statusText: response.statusText,
						headers: storeHeaders,
					});
					schedule(cache.put(key, toStore).catch(() => undefined));
				}
			}

			// Return the MISS response with all raw Set-Cookie headers AND Astro's
			// Symbol.for("astro.cookies") queue intact.
			const missHeaders = new Headers(response.headers);
			missHeaders.delete("cdn-cache-control");
			missHeaders.delete("cloudflare-cdn-cache-control");
			missHeaders.set("cache-control", "private, no-cache");
			missHeaders.set(HEADER_STATUS, "MISS");
			return preserveAstroCookies(
				response,
				new Response(bodyBytes, {
					status: response.status,
					statusText: response.statusText,
					headers: missHeaders,
				}),
			);
		},

		async invalidate(options) {
			if (options.tags) {
				const tags = Array.isArray(options.tags) ? options.tags : [options.tags];
				for (const tag of tags) {
					if (tag.startsWith("widget-area:")) invalidateWidgetObjectCache();
					else if (tag === "site-settings") invalidateObjectCache(CacheNamespace.SETTINGS);
					else if (tag.startsWith("menu:")) invalidateObjectCache(CacheNamespace.MENUS);
				}
			}
			if (options.path) {
				const scope = resolvePageCacheScope(getEnv()[scopeEnvVar]);
				if (!scope) return;
				try {
					const cache = await openCache(cacheNameForScope(scope));
					await cache.delete(options.path);
				} catch {
					// Best-effort local delete; epoch vector handles global invalidation.
				}
			}
		},
	};
}

const factory: CacheProviderFactory<EpochCloudflareCacheConfig> = (config) =>
	createEpochCacheProvider(config);

export default factory;
