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
 * - `fillPrimary` marks an eligible cache-fill render so D1 routes reads to
 *   `first-primary` and `objectCache` is bypassed, coupling stored HTML bytes
 *   to the authoritative primary visibility revision.
 * - `VISIBILITY_REV_OPTION` lives in the canonical `options(name, value, revision)`
 *   table (migrations/001_initial.ts) and uses an opaque UUID revision safe
 *   across both SQLite/D1 and PostgreSQL.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { sql, type Kysely, type RawBuilder } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";

export const PAGE_CACHE_MIN_TTL_SECONDS = 30;
export const PAGE_CACHE_MAX_TTL_SECONDS = 300;
export const VISIBILITY_REV_OPTION = "emdash:visibility_rev";

export interface PageCacheRequestState {
	optedIn: boolean;
	optedOut: boolean;
	ttlSeconds: number;
	fillPrimary: boolean;
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
export function runWithPageCacheState<T>(
	fn: () => T,
	opts?: { fillPrimary?: boolean },
): T {
	return getPageCacheAls().run(
		{
			optedIn: false,
			optedOut: false,
			ttlSeconds: 0,
			fillPrimary: opts?.fillPrimary === true,
		},
		fn,
	);
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
 * Build a dialect-safe statement that advances `emdash:visibility_rev` in the
 * canonical `options(name, value, revision)` table. Join this statement into
 * the same D1 atomic batch or SQL transaction as the visibility mutation so
 * the two commit or roll back together.
 */
export function prepareVisibilityRevBump(revision: string = crypto.randomUUID()): RawBuilder<unknown> {
	const serialized = JSON.stringify(revision);
	return sql`
		INSERT INTO options (name, value, revision)
		VALUES (${VISIBILITY_REV_OPTION}, ${serialized}, ${revision})
		ON CONFLICT (name) DO UPDATE SET
			value = ${serialized},
			revision = ${revision}
	`;
}

/**
 * Advance the authoritative visibility revision via `OptionsRepository`
 * (`options(name, value, revision)`).
 */
export async function bumpVisibilityRev(db: Kysely<Database>): Promise<string> {
	const rev = crypto.randomUUID();
	return new OptionsRepository(db).setVersioned(VISIBILITY_REV_OPTION, rev);
}

/**
 * Read the authoritative visibility revision from `options(name, value, revision)`.
 * Returns `"0"` when never bumped; throws on DB errors so callers fail closed.
 */
export async function readVisibilityRev(db: Kysely<Database>): Promise<string> {
	const row = await db
		.selectFrom("options")
		.select("revision")
		.where("name", "=", VISIBILITY_REV_OPTION)
		.executeTakeFirst();
	return row?.revision ?? "0";
}
