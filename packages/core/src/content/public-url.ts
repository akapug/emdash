/**
 * Tenant-side canonical public URL path resolution by `(collection, entryId)`
 * or by menu translation-group reference `(collection, referenceId, locale)`.
 *
 * Resolves each entry against:
 * - the live published row (never drafts, scheduled, or deleted rows),
 * - public-visibility & discovery checks (`routable`, non-empty slug,
 *   not password-protected, not `seo_no_index = 1`),
 * - the active template's deployed public route contract (`publicRoutes` from
 *   `virtual:emdash/config` — fails closed with `null` when no route contract
 *   proves the deployed template serves the resolved pattern),
 * - the site's configured homepage override, collection `url_pattern`, and
 *   runtime i18n + trailing-slash routing policy.
 */

import { sql, type Kysely } from "kysely";

import { ContentRepository } from "../database/repositories/content.js";
import { ProtectedContentRepository } from "../database/repositories/protected-content.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getI18nConfig } from "../i18n/config.js";
import { localizePath, resolveLocalizedContentRoutePath } from "../i18n/resolve.js";
import { SchemaRegistry } from "../schema/registry.js";
import { getSiteSettingWithDb } from "../settings/index.js";
import { isMissingTableError } from "../utils/db-errors.js";

export type PublicRouteOwner =
	| { kind: "homepage" }
	| { kind: "collection"; collection: string }
	| { kind: "uniqueUrlPattern"; pattern: string };

export interface PublicRouteBinding {
	pattern: string;
	owner: PublicRouteOwner;
}

const UNRESOLVED_TOKEN_RE = /\{[^}]+\}/;
const TRAILING_SLASH_RE = /\/$/;
const PUBLIC_ROUTES_KEY = Symbol.for("emdash:public-routes");

function routeStore(): Record<symbol, readonly PublicRouteBinding[] | null | undefined> {
	return globalThis;
}

/**
 * Configure the active template's collection-aware public route contract
 * (e.g. from integration startup or tests). Pass `null` to clear.
 */
export function setPublicRoutesConfig(routes: readonly PublicRouteBinding[] | null): void {
	routeStore()[PUBLIC_ROUTES_KEY] = routes;
}

/** Read the configured runtime public route contract, if any. */
export function getPublicRoutesConfig(): readonly PublicRouteBinding[] | null | undefined {
	return routeStore()[PUBLIC_ROUTES_KEY];
}

export interface PublicContentPathRef {
	collection: string;
	id?: string;
	referenceId?: string;
	locale?: string;
}

export interface ResolvedPublicContentPath {
	collection: string;
	id?: string;
	referenceId?: string;
	locale?: string;
	path: string | null;
}

export interface ResolvePublicContentPathOptions {
	trailingSlash?: "always" | "never" | "ignore";
	publicRoutes?: readonly PublicRouteBinding[] | null;
}

interface HostVirtualConfig {
	trailingSlash: "always" | "never" | "ignore";
	publicRoutes: readonly PublicRouteBinding[] | null;
}

function isPublicRouteBinding(v: unknown): v is PublicRouteBinding {
	if (typeof v !== "object" || v === null) return false;
	if (!("pattern" in v) || typeof v.pattern !== "string") return false;
	if (!("owner" in v) || typeof v.owner !== "object" || v.owner === null) return false;
	const owner = v.owner;
	if (!("kind" in owner) || typeof owner.kind !== "string") return false;
	if (owner.kind === "homepage") return true;
	if (
		owner.kind === "collection" &&
		"collection" in owner &&
		typeof owner.collection === "string"
	) {
		return true;
	}
	if (
		owner.kind === "uniqueUrlPattern" &&
		"pattern" in owner &&
		typeof owner.pattern === "string"
	) {
		return true;
	}
	return false;
}

async function getHostVirtualConfig(): Promise<HostVirtualConfig> {
	try {
		const mod: unknown = await import("virtual:emdash/config");
		if (typeof mod !== "object" || mod === null || !("default" in mod)) {
			return { trailingSlash: "ignore", publicRoutes: null };
		}
		const def: unknown = mod.default;
		if (typeof def !== "object" || def === null) {
			return { trailingSlash: "ignore", publicRoutes: null };
		}
		const rawTs: unknown = "trailingSlash" in def ? def.trailingSlash : undefined;
		const trailingSlash =
			rawTs === "always" || rawTs === "never" || rawTs === "ignore" ? rawTs : "ignore";
		const rawRoutes: unknown = "publicRoutes" in def ? def.publicRoutes : undefined;
		const publicRoutes = Array.isArray(rawRoutes) ? rawRoutes.filter(isPublicRouteBinding) : null;
		return { trailingSlash, publicRoutes };
	} catch {
		return { trailingSlash: "ignore", publicRoutes: null };
	}
}

function normalizeRoutePattern(pattern: string): string {
	let p = pattern.trim();
	if (!p.startsWith("/")) p = `/${p}`;
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	return p;
}

function applyTrailingSlash(path: string, trailingSlash: "always" | "never" | "ignore"): string {
	if (trailingSlash === "always" && path !== "/") return `${path}/`;
	if (trailingSlash === "never" && path !== "/") return path.replace(TRAILING_SLASH_RE, "");
	return path;
}

interface LocalizedRowCandidate {
	id: string;
	locale: string;
}

/** Matches menus/index.ts:432-444 localized row preference. */
function shouldPreferLocalizedRow(
	candidate: LocalizedRowCandidate,
	existing: LocalizedRowCandidate | undefined,
	locale: string,
): boolean {
	if (!existing) return true;
	if (candidate.locale === locale) return existing.locale !== locale || candidate.id < existing.id;
	if (existing.locale === locale) return false;
	return (
		candidate.locale < existing.locale ||
		(candidate.locale === existing.locale && candidate.id < existing.id)
	);
}

async function resolveEntryIdByTranslationGroup(
	db: Kysely<Database>,
	collection: string,
	referenceId: string,
	locale: string,
): Promise<string | null> {
	validateIdentifier(collection, "collection slug");
	const result = await sql<LocalizedRowCandidate>`
		SELECT id, locale
		FROM ${sql.ref(`ec_${collection}`)}
		WHERE translation_group = ${referenceId}
		AND deleted_at IS NULL
	`.execute(db);
	let preferred: LocalizedRowCandidate | undefined;
	for (const row of result.rows) {
		if (shouldPreferLocalizedRow(row, preferred, locale)) {
			preferred = row;
		}
	}
	if (preferred) return preferred.id;
	// Fallback for legacy rows whose menu reference_id stored the row ID directly.
	return referenceId;
}

async function isNoindexEntry(
	db: Kysely<Database>,
	collection: string,
	contentId: string,
): Promise<boolean> {
	try {
		const row = await db
			.selectFrom("_emdash_seo")
			.select("seo_no_index")
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.where("seo_no_index", "=", 1)
			.executeTakeFirst();
		return row !== undefined;
	} catch (error) {
		if (isMissingTableError(error)) return false;
		throw error;
	}
}

function resultEntry(ref: PublicContentPathRef, path: string | null): ResolvedPublicContentPath {
	return {
		collection: ref.collection,
		...(ref.id !== undefined ? { id: ref.id } : {}),
		...(ref.referenceId !== undefined ? { referenceId: ref.referenceId } : {}),
		...(ref.locale !== undefined ? { locale: ref.locale } : {}),
		path,
	};
}

/**
 * Resolve canonical public relative paths for a batch of `(collection, id)`
 * or menu `(collection, referenceId, locale)` references. Returns one result
 * per input reference in the same order, with `path: null` whenever the entry
 * is not publicly discoverable or the active template does not serve its route.
 */
export async function resolvePublicContentPaths(
	db: Kysely<Database>,
	refs: readonly PublicContentPathRef[],
	options: ResolvePublicContentPathOptions = {},
): Promise<ResolvedPublicContentPath[]> {
	if (refs.length === 0) return [];

	const contentRepo = new ContentRepository(db);
	const protectedRepo = new ProtectedContentRepository(db);
	const registry = new SchemaRegistry(db);
	const [homepage, hostConfig] = await Promise.all([
		getSiteSettingWithDb("homepage", db),
		getHostVirtualConfig(),
	]);
	const trailingSlash = options.trailingSlash ?? hostConfig.trailingSlash;
	const configuredRoutes =
		options.publicRoutes !== undefined
			? options.publicRoutes
			: getPublicRoutesConfig() !== undefined
				? getPublicRoutesConfig()
				: hostConfig.publicRoutes;

	// Fail closed: without an active template route contract, never guess a URL.
	if (!configuredRoutes || configuredRoutes.length === 0) {
		return refs.map((ref) => resultEntry(ref, null));
	}
	const routeBindings = new Map<string, PublicRouteBinding>();
	for (const binding of configuredRoutes) {
		routeBindings.set(normalizeRoutePattern(binding.pattern), binding);
	}
	const defaultLocale = getI18nConfig()?.defaultLocale ?? "en";

	type ResolvedCollection = Awaited<ReturnType<SchemaRegistry["getCollection"]>>;
	const collectionCache = new Map<string, ResolvedCollection>();
	let allCollectionsPromise: Promise<
		Awaited<ReturnType<SchemaRegistry["listCollections"]>>
	> | null = null;
	const getAllCollections = () => {
		if (!allCollectionsPromise) allCollectionsPromise = registry.listCollections();
		return allCollectionsPromise;
	};
	const isOwnedByCollection = async (
		binding: PublicRouteBinding | undefined,
		collection: string,
	): Promise<boolean> => {
		if (!binding) return false;
		if (binding.owner.kind === "collection") {
			return binding.owner.collection === collection;
		}
		if (binding.owner.kind === "uniqueUrlPattern") {
			const wantPattern = normalizeRoutePattern(binding.owner.pattern);
			const all = await getAllCollections();
			const owners = all.filter(
				(c) => c.routable && c.urlPattern && normalizeRoutePattern(c.urlPattern) === wantPattern,
			);
			return owners.length === 1 && owners[0]?.slug === collection;
		}
		return false;
	};
	const getCollection = async (slug: string): Promise<ResolvedCollection> => {
		if (collectionCache.has(slug)) return collectionCache.get(slug) ?? null;
		try {
			validateIdentifier(slug, "collection slug");
		} catch {
			collectionCache.set(slug, null);
			return null;
		}
		const info = await registry.getCollection(slug);
		collectionCache.set(slug, info);
		return info;
	};

	const results: ResolvedPublicContentPath[] = [];
	for (const ref of refs) {
		const collectionInfo = await getCollection(ref.collection);
		if (!collectionInfo || !collectionInfo.routable) {
			results.push(resultEntry(ref, null));
			continue;
		}

		const targetId = ref.referenceId
			? await resolveEntryIdByTranslationGroup(
					db,
					ref.collection,
					ref.referenceId,
					ref.locale || defaultLocale,
				)
			: (ref.id ?? null);
		if (!targetId) {
			results.push(resultEntry(ref, null));
			continue;
		}

		const item = await contentRepo.findById(ref.collection, targetId);
		if (!item || item.status !== "published" || !item.slug || item.slug.trim() === "") {
			results.push(resultEntry(ref, null));
			continue;
		}

		const [protectedRow, noindex] = await Promise.all([
			protectedRepo.find(ref.collection, item.id),
			isNoindexEntry(db, ref.collection, item.id),
		]);
		if (protectedRow || noindex) {
			results.push(resultEntry(ref, null));
			continue;
		}

		const locale = item.locale || defaultLocale;
		const isHomepage =
			homepage != null &&
			homepage.collection === ref.collection &&
			(homepage.id === item.translationGroup || homepage.id === item.id);

		if (isHomepage) {
			if (routeBindings.get("/")?.owner.kind !== "homepage") {
				results.push(resultEntry(ref, null));
				continue;
			}
			const localizedHome = await localizePath("/", locale);
			results.push(
				resultEntry(
					ref,
					localizedHome === null ? null : applyTrailingSlash(localizedHome, trailingSlash),
				),
			);
			continue;
		}

		let candidatePattern: string | null = null;
		if (collectionInfo.urlPattern) {
			candidatePattern = normalizeRoutePattern(collectionInfo.urlPattern);
		} else if (
			await isOwnedByCollection(routeBindings.get(`/${ref.collection}/{slug}`), ref.collection)
		) {
			candidatePattern = `/${ref.collection}/{slug}`;
		} else if (
			ref.collection === "pages" &&
			(await isOwnedByCollection(routeBindings.get("/{slug}"), "pages"))
		) {
			candidatePattern = "/{slug}";
		}

		if (
			!candidatePattern ||
			!(await isOwnedByCollection(routeBindings.get(candidatePattern), ref.collection))
		) {
			results.push(resultEntry(ref, null));
			continue;
		}

		const resolved = await resolveLocalizedContentRoutePath({
			pattern: candidatePattern,
			collection: ref.collection,
			slug: item.slug,
			id: item.id,
			date: item.publishedAt,
			locale,
			trailingSlash,
		});
		const safePath = resolved === null || UNRESOLVED_TOKEN_RE.test(resolved) ? null : resolved;
		results.push(resultEntry(ref, safePath));
	}

	return results;
}
