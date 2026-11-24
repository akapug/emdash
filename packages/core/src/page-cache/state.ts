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

import type { Database } from "../database/types.js";

export const PAGE_CACHE_MIN_TTL_SECONDS = 30;
export const PAGE_CACHE_MAX_TTL_SECONDS = 300;
export const VISIBILITY_REV_OPTION = "emdash:visibility_rev";

export interface PageCacheAuthority {
	activeIncarnation: string;
	visibilityRev: string;
}

export interface PageCacheRequestState {
	optedIn: boolean;
	optedOut: boolean;
	ttlSeconds: number;
	fillPrimary: boolean;
	deadlineMs?: number;
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
export function runWithPageCacheState<T>(fn: () => T, opts?: { fillPrimary?: boolean }): T {
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

/** Bound any route opt-in by an absolute Unix-millisecond deadline. */
export function capPageCacheUntil(deadlineMs: number): void {
	const state = getPageCacheAls().getStore();
	if (!state || state.optedOut) return;
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
		optOutPageCache();
		return;
	}
	state.deadlineMs = Math.min(state.deadlineMs ?? deadlineMs, deadlineMs);
}

/**
 * Build a dialect-safe conditional statement that advances `emdash:visibility_rev`
 * in `options(name, value, revision)` ONLY when an active page-cache incarnation
 * is present (`value <> ''`).
 *
 * Keyed on the authoritative primary database state rather than process env:
 * - When page caching is OFF (row absent or `value = ''`), this updates 0 rows.
 * - When page caching is ON (`value = '<incarnation>'`), even an in-flight or
 *   OFF-era Worker commits the revision bump atomically in the same D1 batch
 *   or SQL transaction as the public-visibility mutation.
 */
export function prepareVisibilityRevBump(
	revision: string = crypto.randomUUID(),
): RawBuilder<unknown> {
	return sql`
		UPDATE options
		SET revision = ${revision}
		WHERE name = ${VISIBILITY_REV_OPTION}
			AND value NOT IN ('', 'null', '""')
	`;
}

/**
 * Activate a fresh, never-reused page-cache incarnation on the primary database.
 * Stores JSON-encoded string in `options.value` for compatibility with
 * `OptionsRepository.getAll()`.
 */
export async function activatePageCacheIncarnation(
	db: Kysely<Database>,
	incarnation: string,
	revision: string = crypto.randomUUID(),
): Promise<PageCacheAuthority> {
	const trimmed = incarnation.trim();
	if (!trimmed) throw new Error("Page cache incarnation must be non-empty");
	const encoded = JSON.stringify(trimmed);
	await sql`
		INSERT INTO options (name, value, revision)
		VALUES (${VISIBILITY_REV_OPTION}, ${encoded}, ${revision})
		ON CONFLICT (name) DO UPDATE SET
			value = ${encoded},
			revision = ${revision}
	`.execute(db);
	return { activeIncarnation: trimmed, visibilityRev: revision };
}

/**
 * Retire the active page-cache incarnation on the primary database (`value = 'null'`,
 * valid JSON for `OptionsRepository.getAll()`). Any old ON Worker reading primary
 * authority stops serving retained copies immediately.
 */
export async function retirePageCacheIncarnation(
	db: Kysely<Database>,
	revision: string = crypto.randomUUID(),
): Promise<void> {
	await sql`
		INSERT INTO options (name, value, revision)
		VALUES (${VISIBILITY_REV_OPTION}, 'null', ${revision})
		ON CONFLICT (name) DO UPDATE SET
			value = 'null',
			revision = ${revision}
	`.execute(db);
}

/**
 * Parse a JSON-encoded `options.value` for `emdash:visibility_rev`.
 * Returns the non-empty active incarnation string, or `null` when retired/invalid.
 */
export function parsePageCacheIncarnationValue(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string" && parsed.trim().length > 0) return parsed.trim();
		return null;
	} catch {
		return null;
	}
}

/**
 * Advance the authoritative visibility revision conditionally (no-op when OFF).
 */
export async function bumpVisibilityRev(
	db: Kysely<Database>,
	revision: string = crypto.randomUUID(),
): Promise<string> {
	await prepareVisibilityRevBump(revision).execute(db);
	return revision;
}

/**
 * Read the authoritative `(activeIncarnation, visibilityRev)` from
 * `options(name, value, revision)`. Returns `null` when absent or retired (`value = 'null'`).
 */
export async function readPageCacheAuthority(
	db: Kysely<Database>,
): Promise<PageCacheAuthority | null> {
	const row = await db
		.selectFrom("options")
		.select(["value", "revision"])
		.where("name", "=", VISIBILITY_REV_OPTION)
		.executeTakeFirst();
	if (!row || !row.revision) return null;
	const activeIncarnation = parsePageCacheIncarnationValue(row.value);
	if (!activeIncarnation) return null;
	return { activeIncarnation, visibilityRev: row.revision };
}

/**
 * Read the authoritative visibility revision from `options(name, value, revision)`.
 * Returns `"0"` when absent; throws on DB errors so callers fail closed.
 */
export async function readVisibilityRev(db: Kysely<Database>): Promise<string> {
	const row = await db
		.selectFrom("options")
		.select("revision")
		.where("name", "=", VISIBILITY_REV_OPTION)
		.executeTakeFirst();
	return row?.revision ?? "0";
}
