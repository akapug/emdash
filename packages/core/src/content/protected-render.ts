import { canActOnOwn, hasScope, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { sql, type Kysely } from "kysely";

import type { EmDashConfig } from "../astro/integration/runtime.js";
import { checkRateLimit, getClientIp } from "../auth/rate-limit.js";
import { getTrustedProxyHeaders } from "../auth/trusted-proxy.js";
import { OptionsRepository } from "../database/repositories/options.js";
import { ProtectedContentRepository } from "../database/repositories/protected-content.js";
import type { ContentItem } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getDb } from "../loader.js";
import { isMissingTableError } from "../utils/db-errors.js";
import { optOutPageCache } from "../page-cache/state.js";
import { verifyContentPassword } from "./protection.js";

export const PROTECTED_RATE_LIMIT_SETTING = "protected_content:rate_limit" as const;

export interface ProtectedRateLimitConfig {
	perIpMax: number;
	perEntryMax: number;
	windowSeconds: number;
}

export const DEFAULT_PROTECTED_RATE_LIMIT: Readonly<ProtectedRateLimitConfig> = Object.freeze({
	perIpMax: 10,
	perEntryMax: 30,
	windowSeconds: 60,
});

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function readProtectedRateLimit(db: Kysely<Database>): Promise<ProtectedRateLimitConfig> {
	try {
		const raw = await new OptionsRepository(db).get(PROTECTED_RATE_LIMIT_SETTING);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PROTECTED_RATE_LIMIT;
		const field = (key: string): unknown => Object.getOwnPropertyDescriptor(raw, key)?.value;
		return {
			perIpMax: positiveInt(field("perIpMax"), DEFAULT_PROTECTED_RATE_LIMIT.perIpMax),
			perEntryMax: positiveInt(field("perEntryMax"), DEFAULT_PROTECTED_RATE_LIMIT.perEntryMax),
			windowSeconds: positiveInt(
				field("windowSeconds"),
				DEFAULT_PROTECTED_RATE_LIMIT.windowSeconds,
			),
		};
	} catch (error) {
		if (isMissingTableError(error)) return DEFAULT_PROTECTED_RATE_LIMIT;
		throw error;
	}
}

const PRIVATE_HEADERS = {
	"Cache-Control": "private, no-store",
	"Content-Type": "text/html; charset=utf-8",
	"X-Robots-Tag": "noindex, nofollow",
	"Referrer-Policy": "no-referrer",
};
function challenge(status = 200): Response {
	return new Response(
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Password protected</title></head><body><main><h1>Password protected</h1><p>This content requires its password.</p><form method="post"><label>Password <input type="password" name="password" required autocomplete="current-password"></label><button type="submit">Read content</button></form></main></body></html>',
		{ status, headers: PRIVATE_HEADERS },
	);
}

/** Unlock only the supplied entry for this render; never prime a query or shared cache. */
export async function resolveProtectedEntry<T extends { data: { id: string } }>(
	context: {
		request: Request;
		response: { headers: Headers };
		cache?: APIContext["cache"];
		locals?: { emdash?: { config?: EmDashConfig } };
	},
	collection: string,
	entry: T,
): Promise<{ entry: T; protected: boolean } | { response: Response }> {
	validateIdentifier(collection, "collection");
	const db = await getDb();
	let row;
	try {
		row = (
			await sql<{
				verifier: string;
				credential_version: number;
				status: string;
				live_revision_id: string | null;
				draft_revision_id: string | null;
				deleted_at: string | null;
			}>`
			SELECT p.verifier, p.credential_version, c.status, c.live_revision_id, c.draft_revision_id, c.deleted_at
			FROM _emdash_protected_content AS p JOIN ${sql.ref(`ec_${collection}`)} AS c ON c.id = p.content_id
			WHERE p.collection = ${collection} AND p.content_id = ${entry.data.id}
		`.execute(db)
		).rows[0];
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
		return { entry, protected: false };
	}
	if (!row) return { entry, protected: false };
	optOutPageCache();
	if (context.cache?.enabled) context.cache.set(false);
	for (const [name, value] of Object.entries(PRIVATE_HEADERS))
		context.response.headers.set(name, value);
	if (row.status !== "published" || row.deleted_at !== null) return { response: challenge(404) };
	const { request } = context;
	if (request.method !== "POST") return { response: challenge() };
	const rateConfig = await readProtectedRateLimit(db);
	const bucket = `protected:${collection}:${entry.data.id}`;
	const clientIp = getClientIp(request, getTrustedProxyHeaders(context.locals?.emdash?.config));
	// Never fail open when no trusted IP is present: fall back to a shared per-entry unknown bucket,
	// and always enforce the per-entry global ceiling alongside the per-IP ceiling.
	const ipLimit = await checkRateLimit(
		db,
		clientIp ?? "unknown",
		bucket,
		rateConfig.perIpMax,
		rateConfig.windowSeconds,
	);
	const entryLimit = await checkRateLimit(
		db,
		"entry",
		bucket,
		rateConfig.perEntryMax,
		rateConfig.windowSeconds,
	);
	if (!ipLimit.allowed || !entryLimit.allowed) {
		const response = challenge(429);
		response.headers.set("Retry-After", String(rateConfig.windowSeconds));
		return { response };
	}
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) return { response: challenge(403) };
	if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
		return { response: challenge(415) };
	const reader = request.body?.getReader();
	if (!reader) return { response: challenge(403) };
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 8192) {
			await reader.cancel();
			return { response: challenge(413) };
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const form = new URLSearchParams(new TextDecoder().decode(bytes));
	const values = form.getAll("password");
	let verifier: unknown;
	try {
		verifier = JSON.parse(row.verifier);
	} catch {
		return { response: challenge(503) };
	}
	if (values.length !== 1 || !(await verifyContentPassword(values[0], verifier)))
		return { response: challenge(403) };
	// Recheck after the expensive derivation so deletion/unpublication or credential rotation cannot grant stale access.
	const current = (
		await sql<{
			verifier: string;
			credential_version: number;
			status: string;
			deleted_at: string | null;
			data: string;
			revision_data: string | null;
			seo: string | null;
		}>`
		SELECT p.verifier, p.credential_version, p.data, p.seo, c.status, c.deleted_at, r.data AS revision_data
		FROM _emdash_protected_content AS p JOIN ${sql.ref(`ec_${collection}`)} AS c ON c.id = p.content_id
		LEFT JOIN _emdash_protected_revisions AS r ON r.revision_id = c.live_revision_id AND r.collection = p.collection AND r.content_id = p.content_id
		WHERE p.collection = ${collection} AND p.content_id = ${entry.data.id}
	`.execute(db)
	).rows[0];
	if (
		!current ||
		current.status !== "published" ||
		current.deleted_at !== null ||
		current.credential_version !== row.credential_version ||
		current.verifier !== row.verifier
	)
		return { response: challenge(403) };
	const data = JSON.parse(current.revision_data ?? current.data);
	const seo = current.seo ? JSON.parse(current.seo) : undefined;
	return {
		entry: { ...entry, data: { ...entry.data, ...data, ...(seo ? { seo } : {}) } },
		protected: true,
	};
}

/** Editorial hydration requires ownership-aware edit authority, including token write scope. */
export async function hydrateProtectedContentForEditor(
	db: Kysely<Database>,
	item: ContentItem,
	user: { id: string; role: RoleLevel } | null | undefined,
	tokenScopes?: string[],
): Promise<ContentItem> {
	if (
		!user ||
		!canActOnOwn(user, item.authorId ?? "", "content:edit_own", "content:edit_any") ||
		(tokenScopes && !hasScope(tokenScopes, "content:write"))
	)
		return item;
	const repo = new ProtectedContentRepository(db);
	const data = await repo.readData(item, true);
	if (!data) return item;
	const row = await repo.find(item.type, item.id);
	return { ...item, data, ...(row?.seo ? { seo: JSON.parse(row.seo) } : {}) };
}
