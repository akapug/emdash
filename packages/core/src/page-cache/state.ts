/**
 * Per-request full-page cache state and authoritative visibility revision.
 *
 * Uses a globalThis-keyed AsyncLocalStorage singleton (same pattern as
 * `request-context.ts`) so Vite SSR chunk splitting never forks state across
 * middleware, layouts, nested/streamed components, or rewrites.
 *
 * Invariants:
 * - `optOutPageCache()` is IRREVERSIBLE for the lifetime of the request. A
 *   subsequent `optInPageCache()` call never clears `optedOut`.
 * - `optInPageCache(ttlSeconds)` requires an explicit positive TTL; tag-only
 *   hints or missing headers never opt a response in.
 * - `VISIBILITY_REV_OPTION` lives in the primary database `options` table so
 *   public -> draft/deleted/password-protected transitions are checked
 *   authoritatively on every cache HIT even while KV lags 60s+ or is down.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { sql, type Kysely } from "kysely";

import type { Database } from "../database/types.js";

export const PAGE_CACHE_MIN_TTL_SECONDS = 30;
export const PAGE_CACHE_MAX_TTL_SECONDS = 300;
export const VISIBILITY_REV_OPTION = "emdash:visibility_rev";

export interface PageCacheRequestState {
	optedIn: boolean;
	optedOut: boolean;
	ttlSeconds: number;
}

const STATE_ALS_KEY = Symbol.for("emdash.pageCacheState");

function getPageCacheAls(): AsyncLocalStorage<PageCacheRequestState> {
	const g = globalThis as Record<symbol, AsyncLocalStorage<PageCacheRequestState> | undefined>;
	let als = g[STATE_ALS_KEY];
	if (!als) {
		als = new AsyncLocalStorage<PageCacheRequestState>();
		g[STATE_ALS_KEY] = als;
	}
	return als;
}

/** Run `fn` inside a fresh per-request page-cache eligibility scope. */
export function runWithPageCacheState<T>(fn: () => T): T {
	return getPageCacheAls().run({ optedIn: false, optedOut: false, ttlSeconds: 0 }, fn);
}

/** Read the current request's page-cache state, or `undefined` outside a scope. */
export function getPageCacheState(): PageCacheRequestState | undefined {
	return getPageCacheAls().getStore();
}

/**
 * Irreversibly opt the current request out of full-page caching.
 * Safe to call from layouts, nested/streamed components, protected-render
 * gates, or middleware; no later `optInPageCache()` can re-enable storage.
 */
export function optOutPageCache(): void {
	const state = getPageCacheAls().getStore();
	if (!state) return;
	state.optedOut = true;
	state.optedIn = false;
	state.ttlSeconds = 0;
}

/**
 * Explicitly opt the current request into full-page caching with a positive
 * internal TTL (clamped to `[PAGE_CACHE_MIN_TTL_SECONDS, PAGE_CACHE_MAX_TTL_SECONDS]`).
 * No-op if `ttlSeconds <= 0` or if the request has already opted out.
 */
export function optInPageCache(ttlSeconds: number): void {
	const state = getPageCacheAls().getStore();
	if (!state || state.optedOut) return;
	if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
	const clamped = Math.min(
		PAGE_CACHE_MAX_TTL_SECONDS,
		Math.max(PAGE_CACHE_MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
	);
	state.optedIn = true;
	state.ttlSeconds = state.ttlSeconds > 0 ? Math.min(state.ttlSeconds, clamped) : clamped;
}

/**
 * Atomically advance the primary database's authoritative visibility revision.
 * Called synchronously whenever content leaves public visibility (unpublish,
 * soft-delete, permanent delete, or password protection creation/change).
 */
export async function bumpVisibilityRev(db: Kysely<Database>): Promise<void> {
	const now = Date.now();
	const updatedAt = new Date(now).toISOString();
	await sql`
		INSERT INTO options (key, value, updated_at)
		VALUES (${VISIBILITY_REV_OPTION}, ${String(now)}, ${updatedAt})
		ON CONFLICT (key) DO UPDATE SET
			value = CAST(
				CASE
					WHEN CAST(options.value AS INTEGER) >= ${now}
					THEN CAST(options.value AS INTEGER) + 1
					ELSE ${now}
				END AS TEXT
			),
			updated_at = ${updatedAt}
	`.execute(db);
}

/**
 * Read the authoritative visibility revision from the database.
 * Returns `"0"` when the option has never been bumped; throws on DB errors so
 * callers fail closed.
 */
export async function readVisibilityRev(db: Kysely<Database>): Promise<string> {
	const row = await db
		.selectFrom("options")
		.select("value")
		.where("key", "=", VISIBILITY_REV_OPTION)
		.executeTakeFirst();
	return row?.value ?? "0";
}
