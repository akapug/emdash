/**
 * WordPress WXR execute import endpoint
 *
 * POST /_emdash/api/import/wordpress/execute
 *
 * Accepts WXR file and import configuration, imports content into the database.
 */

import {
	gutenbergToPortableText,
	texturizeNote,
	texturizes,
	wptexturize,
} from "@emdash-cms/gutenberg-to-portable-text";
import type { APIRoute } from "astro";
import {
	parseWxrString,
	ContentRepository,
	importReusableBlocksAsSections,
	type WxrData,
	type WxrPost,
	parseWxrDate,
	parseScheduledWxrDate,
} from "emdash";
import { sql } from "kysely";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { BylineRepository } from "#db/repositories/byline.js";
import { SeoRepository } from "#db/repositories/seo.js";
import { importWxrComments, prepareWxrPostComments } from "#import/comments.js";
import { importProtection, type ProtectedImportOptions } from "#import/protection.js";
import { resolveImportByline } from "#import/utils.js";
import {
	emptyWxrSeoTally,
	extractWxrSeo,
	hasWxrSeo,
	tallyWxrSeo,
	tallyWxrSeoNoCollection,
	wxrSeoSite,
	wxrUrlKey,
	type WxrSeoSite,
	type WxrSeoTally,
} from "#import/wxr-seo.js";
import {
	attachPostTaxonomies,
	canonicalSourceTermIdentities,
	isWxrTaxonomyConflictError,
	loadAtomicTaxonomyStateFromDb,
	mirrorTermsToLocales,
	planAtomicPostTaxonomies,
	preImportWxrTaxonomies,
	recordCommittedAtomicTerms,
	setPostTermAssignmentsReplacing,
	type AtomicTaxonomyState,
	type TaxonomyImportPlan,
} from "#import/wxr-taxonomies.js";
import type { EmDashHandlers, EmDashManifest } from "#types";
import { slugify } from "#utils/slugify.js";

import { after } from "../../../../../after.js";
import {
	AtomicWxrImportRepository,
	canonicalCommentsPlan,
	canonicalJson,
	sha256Hex,
	supportsAtomicWxrImport,
	type AtomicWxrItemReceipt,
	type WxrSourceAuthor,
} from "../../../../../database/repositories/wxr-atomic-import.js";
import { validateIdentifier } from "../../../../../database/validate.js";
import { getI18nConfig, resolveContentCreateLocale } from "../../../../../i18n/config.js";
import { interpolateUrlPattern } from "../../../../../i18n/resolve.js";
import {
	isIncrementalCaptureActive,
	processDueMediaUsageWork,
} from "../../../../../media/usage/work-processor.js";
import {
	coalesceObjectCacheWrites,
	flushCoalescedObjectCacheWrites,
	invalidateBylineObjectCache,
	invalidateCollectionCache,
	invalidateTaxonomyObjectCache,
} from "../../../../../object-cache/index.js";
import { sanitizeSlug } from "./analyze.js";
import {
	contentWithMappedEmbed,
	mappedEmbedsSchema,
	type MappedPostEmbeds,
} from "./mapped-embeds.js";
import { mappedFieldsSchema, validateMappedFields, wpExecuteConfig } from "./mapped-fields.js";

export const prerender = false;

export interface ImportConfig extends ProtectedImportOptions {
	/** Map WordPress post types to EmDash collections */
	postTypeMappings: Record<
		string,
		{
			collection: string;
			enabled: boolean;
		}
	>;
	/** Whether to skip items that already exist (by slug) */
	skipExisting: boolean;
	/** Whether to import reusable blocks (wp_block) as sections */
	importSections?: boolean;
	/** Author mappings (WP author login -> EmDash user ID) */
	authorMappings?: Record<string, string | null>;
	/** BCP 47 locale for all imported items. When omitted, defaults to defaultLocale. */
	locale?: string;
	/** Carry per-post SEO from Yoast SEO, Rank Math and All in One SEO postmeta. Defaults to true. */
	importSeo?: boolean;
	/** Additive collection fields keyed by WordPress source post ID, included in the original create. */
	mappedFields?: Record<string, Record<string, unknown>>;
	/** View definitions by source post and MEC view ID; legacy single-block values remain accepted. */
	embeds?: Record<string, MappedPostEmbeds>;
	/** Carry each item's approved comments (`importWxrComments`). Defaults to true. */
	importComments?: boolean;
	/** Host installation lineage for atomic producer receipts (file digest used only as fallback). */
	sourceLineage?: string;
	/** Opt into atomic per-post D1 batch import with durable producer receipts. */
	atomic?: boolean;
}

export interface ImportResult {
	success: boolean;
	imported: number;
	skipped: number;
	/** Source rows whose fingerprint changed since import and were left as imported (atomic path). */
	changed?: number;
	errors: Array<{ title: string; error: string }>;
	byCollection: Record<string, number>;
	/** Per-item producer receipts when atomic per-post WXR import is active. */
	items?: AtomicWxrItemReceipt[];
	/** Sections import results (if enabled) */
	sections?: {
		created: number;
		skipped: number;
	};
	/** Taxonomy import results (categories, tags, custom taxonomies). */
	taxonomies?: {
		/** Terms newly created during this import, keyed by taxonomy name. */
		termsCreated: Record<string, number>;
		/** Existing terms that were re-used, keyed by taxonomy name. */
		termsReused: Record<string, number>;
		/** Total pivot rows (post <-> term) written to `content_taxonomies`. */
		assignments: number;
		/**
		 * Custom taxonomy names from the WXR file that had no matching EmDash
		 * definition and were therefore skipped. Lets the admin UI surface a
		 * "create taxonomy X first" hint without re-running the import.
		 */
		missingTaxonomies: string[];
	};
	/** Per-post SEO carried into the SEO fields, and what could not be (when `importSeo` is on). */
	seo?: WxrSeoTally;
	/**
	 * The typography the text was stored in: as WordPress printed it
	 * (wptexturize, English quote marks) for a site in English or one whose
	 * export names no language, as written otherwise. A post's own locale
	 * (WPML, Polylang) decides for that post.
	 */
	typography?: { language: string | null; texturized: boolean; note: string };
	/**
	 * The export's comments: how many approved ones were stored, how many
	 * were stored already (a re-run), and every other one by why it was not
	 * carried (`importWxrComments`). Absent when `importComments` is false.
	 */
	comments?: { imported: number; skipped: number; notCarried: Record<string, number> };
	/**
	 * Password-bearing items kept as drafts without a verified runtime opt-in,
	 * including explicitly redacted credentials that cannot be recovered.
	 */
	drafted?: Array<{ title: string; reason: "password-protected" | "password-unrecoverable" }>;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleContentCreate) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	try {
		const emdashManifest = await emdash.getManifest();

		const formData = await request.formData();
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;
		const configEntry = formData.get("config");
		const configJson = typeof configEntry === "string" ? configEntry : null;

		if (!file) {
			return apiError("VALIDATION_ERROR", "No file provided", 400);
		}

		if (!configJson) {
			return apiError("VALIDATION_ERROR", "No config provided", 400);
		}

		const config = await parseBody(
			new Request(request.url, { method: "POST", body: configJson }),
			wpExecuteConfig,
		);
		if (isParseError(config)) return config;

		// Refuse unsupported atomic mode BEFORE any preparation writes (taxonomy pre-import / mirroring).
		if (
			config.atomic &&
			(typeof emdash.handleContentCreateAtomicWxr !== "function" ||
				!supportsAtomicWxrImport(emdash.db))
		) {
			return apiError(
				"ATOMIC_BATCH_UNSUPPORTED",
				"Atomic WXR import requires an atomic batch or transactional database adapter",
				400,
			);
		}

		// Parse WXR
		const text = await file.text();
		const wxr = await parseWxrString(text);

		// Refuse raw-password WXR in atomic mode BEFORE any writes (salted verifiers
		// are non-deterministic across retries; require pre-supplied config.protections
		// or redacted passwords).
		if (
			config.atomic &&
			config.protectedContent === "emdash.protected-content.v1" &&
			config.passwordSource === "raw-wxr" &&
			wxr.posts.some((post) => {
				const mapping = config.postTypeMappings[post.postType || "post"];
				if (!mapping?.enabled) return false;
				const carried = config.protections?.[String(post.id)];
				return Boolean(post.postPassword) && carried === undefined;
			})
		) {
			return apiError(
				"ATOMIC_RAW_PASSWORD_UNSUPPORTED",
				"Atomic WXR import does not support raw WXR passwords; supply deterministic config.protections or redact passwords",
				400,
			);
		}

		// Build attachment ID -> URL map for featured images
		const attachmentMap = new Map<string, string>();
		for (const att of wxr.attachments) {
			if (att.id && att.url) {
				attachmentMap.set(String(att.id), att.url);
			}
		}

		// Build author login -> display name map
		const authorDisplayNames = new Map<string, string>();
		for (const author of wxr.authors) {
			if (!author.login) continue;
			authorDisplayNames.set(author.login, author.displayName || author.login);
		}

		return await coalesceObjectCacheWrites(async () => {
			let taxonomyPlan: TaxonomyImportPlan | undefined;
			let atomicTaxonomyState: AtomicTaxonomyState | undefined;

			if (config.atomic) {
				// Atomic path: load existing taxonomy defs and terms READ-ONLY (zero writes,
				// zero conflict throws before per-post receipt/slug classification). Missing
				// terms and locale mirrors are inserted INSIDE each new post's atomic batch.
				atomicTaxonomyState = await loadAtomicTaxonomyStateFromDb(
					emdash.db,
					wxr.categories,
					wxr.tags,
					wxr.terms,
				);
			} else {
				// Pre-create taxonomy terms (categories, tags, custom taxonomies) so
				// per-post assignments can resolve to existing rows. Done before any
				// content insert because WXR exports list terms at the top of the
				// file but per-item assignments only reference them by slug.
				taxonomyPlan = await preImportWxrTaxonomies(
					emdash.db,
					wxr.posts,
					wxr.categories,
					wxr.tags,
					wxr.terms,
					config.locale,
				);

				// Multilingual imports (WPML / Polylang -- see #1080) need a term
				// row at each per-post locale, all sharing the canonical term's
				// `translation_group`. Without this, `getTermsForEntry(..., locale)`
				// on non-canonical translations comes back empty.
				const postLocales = new Set<string>();
				for (const post of wxr.posts) {
					if (post.locale) postLocales.add(post.locale);
				}
				if (postLocales.size > 0) {
					try {
						await mirrorTermsToLocales(emdash.db, taxonomyPlan, postLocales, config.locale);
					} catch (mirrorError) {
						if (isWxrTaxonomyConflictError(mirrorError)) {
							console.error("[WXR_IMPORT_TAXONOMY_CONFLICT]", mirrorError);
							return apiError("WXR_IMPORT_TAXONOMY_CONFLICT", mirrorError.publicMessage, 409);
						}
						throw mirrorError;
					}
				}
			}

			const seoSite = wxrSeoContext(wxr, config, emdashManifest);
			const fallbackSourceLineage = config.atomic ? `wxr:${await sha256Hex(text)}` : undefined;
			const effectiveSourceLineage = config.atomic
				? (config.sourceLineage ?? fallbackSourceLineage ?? `wxr:${await sha256Hex(text)}`)
				: "";

			// Import content (locale from config scopes all items)
			const result = await importContent(
				wxr.posts,
				config,
				emdash,
				emdashManifest,
				attachmentMap,
				config.locale,
				authorDisplayNames,
				taxonomyPlan,
				seoSite,
				wxr.site.language,
				wxr.site.generator,
				{
					fallbackSourceLineage,
					siteLink: wxr.site.link,
					atomicTaxonomyState,
				},
			);

			// Import reusable blocks as sections (if enabled)
			if (config.importSections !== false) {
				if (config.atomic) {
					const canonicalLocale = resolveContentCreateLocale(config.locale);
					await importReusableBlocksAsSectionsAtomic(
						wxr.posts,
						emdash.db,
						effectiveSourceLineage,
						canonicalLocale,
						result,
					);
				} else {
					const sectionsResult = await importReusableBlocksAsSections(wxr.posts, emdash.db);
					result.sections = {
						created: sectionsResult.sectionsCreated,
						skipped: sectionsResult.sectionsSkipped,
					};
					// Add section errors to main errors array
					result.errors.push(...sectionsResult.errors);
					if (sectionsResult.errors.length > 0) {
						result.success = false;
					}
				}
			}

			return apiSuccess(result);
		});
	} catch (error) {
		return handleError(error, "Failed to import content", "WXR_IMPORT_ERROR");
	}
};

export const DEFAULT_EPOCH_FLUSH_INTERVAL = 25;

function readCreatedItem(
	data: unknown,
): { id: string; slug?: string | null; locale?: string | null } | undefined {
	if (typeof data !== "object" || data === null || !("item" in data)) return undefined;
	const item = data.item;
	if (typeof item !== "object" || item === null || !("id" in item) || typeof item.id !== "string") {
		return undefined;
	}
	return {
		id: item.id,
		slug: "slug" in item && typeof item.slug === "string" ? item.slug : null,
		locale: "locale" in item && typeof item.locale === "string" ? item.locale : null,
	};
}

interface PreloadedExisting {
	byLocale: Map<string, string>;
	anyLocale: Map<string, { id: string; locale: string }>;
}

function recordExisting(
	preloaded: PreloadedExisting,
	rowSlug: string,
	rowLocale: string,
	rowId: string,
): void {
	preloaded.byLocale.set(`${rowSlug}\0${rowLocale}`, rowId);
	const current = preloaded.anyLocale.get(rowSlug);
	if (!current || rowLocale < current.locale) {
		preloaded.anyLocale.set(rowSlug, { id: rowId, locale: rowLocale });
	}
}

export async function importContent(
	posts: WxrPost[],
	config: ImportConfig,
	emdash: EmDashHandlers,
	manifest: EmDashManifest,
	attachmentMap: Map<string, string>,
	locale: string | undefined,
	authorDisplayNames: Map<string, string> | undefined,
	taxonomyPlan: TaxonomyImportPlan | undefined,
	seoSite?: WxrSeoSite,
	siteLanguage?: string,
	/** The export's `<generator>`: another program's export is stored as written (texturizes). */
	generator?: string,
	options?: {
		/** Flush held object-cache epoch writes every N created rows (default 25). */
		epochFlushInterval?: number;
		/** File-digest lineage fallback when caller does not supply `config.sourceLineage`. */
		fallbackSourceLineage?: string;
		/** Parsed `<channel><link>` included in per-item fingerprints for reconciliation. */
		siteLink?: string;
		/** Read-only atomic taxonomy state (atomic mode only; zero writes before classification). */
		atomicTaxonomyState?: AtomicTaxonomyState;
	},
): Promise<ImportResult> {
	const atomicTaxonomyState = config.atomic
		? (options?.atomicTaxonomyState ?? (await loadAtomicTaxonomyStateFromDb(emdash.db, [], [], [])))
		: undefined;
	const result: ImportResult = {
		success: true,
		imported: 0,
		skipped: 0,
		errors: [],
		byCollection: {},
		typography: {
			language: siteLanguage?.trim() || null,
			texturized: texturizes(siteLanguage, generator),
			note: texturizeNote(siteLanguage, generator),
		},
		taxonomies: {
			termsCreated: taxonomyPlan?.termsCreated ?? atomicTaxonomyState?.termsCreated ?? {},
			termsReused: taxonomyPlan?.termsReused ?? atomicTaxonomyState?.termsReused ?? {},
			assignments: 0,
			missingTaxonomies: taxonomyPlan?.missingTaxonomies ?? [],
		},
	};

	// Item 163c/163d: unknown page-builder containers and dropped no-markup descendants, summed across this import.
	const containerTally = new Map<string, number>();
	const droppedNoMarkupTally = new Map<string, number>();
	let flatContainers = 0;

	const mappedFields = mappedFieldsSchema.safeParse(config.mappedFields);
	if (!mappedFields.success) {
		result.success = false;
		result.errors.push({
			title: "Import configuration",
			error: "Invalid mappedFields configuration",
		});
		return result;
	}

	const embeds = mappedEmbedsSchema.safeParse(config.embeds);
	if (!embeds.success) {
		result.success = false;
		result.errors.push({ title: "Import configuration", error: "Invalid embeds configuration" });
		return result;
	}

	const seoTally = seoSite && config.importSeo !== false ? emptyWxrSeoTally() : undefined;
	if (seoTally) result.seo = seoTally;

	// Create content repository for checking existing items
	const contentRepo = new ContentRepository(emdash.db);
	const seoRepo = new SeoRepository(emdash.db);
	const bylineRepo = new BylineRepository(emdash.db);
	const bylineCache = new Map<string, string>();
	const defaultLocale = getI18nConfig()?.defaultLocale ?? "en";

	const enabledCollections = new Set<string>();
	for (const mapping of Object.values(config.postTypeMappings)) {
		if (!mapping?.enabled) continue;
		const col = sanitizeSlug(mapping.collection);
		if (manifest?.collections[col]) enabledCollections.add(col);
	}

	const useAtomic = config.atomic === true;
	if (
		useAtomic &&
		(typeof emdash.handleContentCreateAtomicWxr !== "function" ||
			!supportsAtomicWxrImport(emdash.db))
	) {
		result.success = false;
		result.errors.push({
			title: "Import configuration",
			error: "Atomic WXR import requested but runtime or database adapter does not support it",
		});
		return result;
	}
	const effectiveSourceLineage = useAtomic
		? (config.sourceLineage ??
			options?.fallbackSourceLineage ??
			`wxr:${await sha256Hex(
				canonicalJson(
					posts.map((p, idx) => [idx, p.id ?? null, p.postName ?? null, p.title ?? null]),
				),
			)}`)
		: "";
	if (useAtomic) {
		result.items = [];
		result.changed = 0;
		if (config.importComments !== false) {
			result.comments = { imported: 0, skipped: 0, notCarried: {} };
		}
	}

	const canonicalDefaultLocale = resolveContentCreateLocale(locale);
	const atomicPostLocales = new Set<string>();
	if (useAtomic) {
		for (const p of posts) {
			if (p.locale) atomicPostLocales.add(p.locale);
		}
	}

	// Preload existing (slug, locale) -> id once per enabled collection when
	// skipExisting is active on the legacy path so preload HITs skip without a DB
	// round-trip. Any preload MISS is still confirmed with findBySlug before creating.
	const existingByCollection = new Map<string, PreloadedExisting>();
	const existingSeoByCollection = new Map<string, Set<string>>();
	if (config.skipExisting && !useAtomic) {
		for (const col of enabledCollections) {
			validateIdentifier(col, "collection name");
			const rows = await sql<{ id: string; slug: string | null; locale: string | null }>`
				SELECT id, slug, locale
				FROM ${sql.ref(`ec_${col}`)}
				WHERE deleted_at IS NULL AND slug IS NOT NULL
				ORDER BY locale ASC
			`.execute(emdash.db);
			const preloaded: PreloadedExisting = {
				byLocale: new Map<string, string>(),
				anyLocale: new Map<string, { id: string; locale: string }>(),
			};
			for (const row of rows.rows) {
				if (!row.slug) continue;
				recordExisting(preloaded, row.slug, row.locale ?? defaultLocale, row.id);
			}
			existingByCollection.set(col, preloaded);

			if (seoTally && manifest.collections[col]?.hasSeo === true && preloaded.anyLocale.size > 0) {
				const seoRows = await emdash.db
					.selectFrom("_emdash_seo")
					.select("content_id")
					.where("collection", "=", col)
					.execute();
				existingSeoByCollection.set(col, new Set(seoRows.map((r) => r.content_id)));
			}
		}
	}

	const incrementalCaptureActive = await isIncrementalCaptureActive(emdash.db);
	let createdWithDeferredUsage = 0;
	const epochFlushInterval = options?.epochFlushInterval ?? DEFAULT_EPOCH_FLUSH_INTERVAL;
	let createdSinceFlush = 0;

	// Source-side translation group ID -> the EmDash ID of the first RECEIPTED
	// post we imported for that group. Skipped, changed, or conflicting anchors
	// are tracked separately so new siblings refuse instead of detaching into
	// standalone rows or mutating the blocked anchor.
	const translationGroupMap = new Map<string, string>();
	const blockedTranslationGroups = new Set<string>();

	// WP post ID -> the EmDash entry it is (stored now, or found already
	// stored), and its collection: where the item's comments go.
	const contentIdByWpId = new Map<number, string>();
	const collectionByWpId = new Map<number, string>();
	const stored = (post: WxrPost, collection: string, id: string) => {
		if (post.id === undefined) return;
		contentIdByWpId.set(post.id, id);
		collectionByWpId.set(post.id, collection);
	};

	for (const [postIndex, post] of posts.entries()) {
		const postType = post.postType || "post";
		const mapping = config.postTypeMappings[postType];

		// Skip if not mapped or disabled
		if (!mapping || !mapping.enabled) {
			result.skipped++;
			continue;
		}

		// Defensive: mapping.collection is already sanitized by prepare, but the user
		// could manually edit the import config between prepare and execute.
		const collection = sanitizeSlug(mapping.collection);

		// Check if collection exists in manifest
		if (!manifest?.collections[collection]) {
			result.errors.push({
				title: post.title || "Untitled",
				error: `Collection "${collection}" does not exist`,
			});
			continue;
		}

		try {
			const mappedData = mappedFields.data?.[String(post.id)] ?? {};
			if (mappedFields.data !== undefined && Object.keys(mappedData).length > 0) {
				validateMappedFields(
					mappedData,
					manifest.collections[collection].fields,
					postType === "mec-events",
				);
			}

			// The text as WordPress printed it, in English (texturizes); a post's own locale decides for it.
			const texturize = texturizes(post.locale ?? siteLanguage, generator);

			// Convert content to Portable Text
			const mappedEmbed = embeds.data?.[String(post.id)];
			const converted = mappedEmbed
				? contentWithMappedEmbed(post.content ?? "", mappedEmbed, String(post.id), { texturize })
				: {
						content: post.content ? gutenbergToPortableText(post.content, { texturize }) : [],
						warnings: [],
					};
			const content = converted.content;

			// Generate deterministic slug from post name or title (never Date.now() so
			// nameless missing-ID items produce the exact same key on retry).
			const slug =
				post.postName ||
				slugify(post.title || `post-${post.id !== undefined ? post.id : `item-${postIndex}`}`);

			const seo = seoTally && seoSite ? extractWxrSeo(post, seoSite) : undefined;
			const collectionHasSeo = manifest.collections[collection]?.hasSeo === true;

			// Per-post locale: prefer the value extracted from WPML/Polylang
			// metadata; fall back to the upload-wide locale. Two translations
			// sharing `post_name` (e.g. /en/hello + /ar/hello) collide on the
			// `UNIQUE(slug, locale)` constraint when they share a locale, so
			// honouring the per-post value is what makes multilingual imports
			// land correctly. See issue #1080.
			const postLocale = post.locale ?? locale;

			// Check if already exists (idempotency) on the legacy path. On the
			// atomic path, receipt lookup + unreceipted-slug skip happen inside
			// handleContentCreateAtomicWxr with ZERO writes (no legacy SEO fill,
			// no unreceipted translationGroupMap authority).
			if (config.skipExisting && !useAtomic) {
				const preloaded = existingByCollection.get(collection);
				const preloadHit = preloaded
					? postLocale !== undefined
						? preloaded.byLocale.get(`${slug}\0${postLocale}`)
						: preloaded.anyLocale.get(slug)?.id
					: undefined;
				const existingRow = preloadHit
					? undefined
					: await contentRepo.findBySlug(collection, slug, postLocale);
				const existingId = preloadHit ?? existingRow?.id;
				if (existingId) {
					if (preloaded && existingRow) {
						recordExisting(
							preloaded,
							existingRow.slug ?? slug,
							existingRow.locale ?? defaultLocale,
							existingRow.id,
						);
					}
					stored(post, collection, existingId);
					// Record the translation group mapping so later
					// translations in this WXR can link to the existing
					// item. We deliberately trust the WXR's grouping over
					// the existing row's `translation_group`: a singleton
					// existing row gets folded into the WXR's group when
					// `handleContentCreate` resolves the new translation's
					// `translationOf`. Pre-existing translations that
					// already belong to a different group are left alone --
					// the user is responsible for reconciling those through
					// the admin if they don't match the WXR.
					if (post.translationGroup) {
						translationGroupMap.set(post.translationGroup, existingId);
					}
					// An entry imported before its SEO was carried gets it now,
					// unless it already has an SEO row of its own.
					if (seoTally && seo?.found && collectionHasSeo && hasWxrSeo(seo)) {
						const knownSeo = existingSeoByCollection.get(collection);
						if (knownSeo?.has(existingId)) {
							seoTally.keptExisting++;
						} else if (await seoRepo.insertIfAbsent(collection, existingId, seo.seo)) {
							knownSeo?.add(existingId);
							seoTally.filledExisting++;
							tallyWxrSeo(seoTally, seo);
						} else {
							knownSeo?.add(existingId);
							seoTally.keptExisting++;
						}
					}
					result.skipped++;
					continue;
				}
			}

			// Resolve translation group: if this post belongs to a group and
			// we've already imported one of its translations, link to it.
			let translationOf: string | undefined;
			if (post.translationGroup) {
				translationOf = translationGroupMap.get(post.translationGroup);
			}

			const protection = await importProtection(post, config);
			// Preserve original WordPress dates for createdAt/publishedAt, while
			// scheduling a `future` post ONLY from an explicitly zoned moment.
			const parsedDate = parseWxrDate(post.postDateGmt, post.pubDate, post.postDate);
			const scheduledMoment =
				post.status === "future"
					? parseScheduledWxrDate(post.postDateGmt, post.pubDate, post.postDate)
					: { date: null, unzonedLocalOnly: false };
			const status =
				protection.protected && !protection.protection
					? "draft"
					: mapStatus(post.status, scheduledMoment.date);
			// Always create a scheduled item as `draft` first so there is never a
			// public window and a failed `handleContentSchedule` leaves the row as a
			// real `draft` rather than `status = 'scheduled'` with `scheduled_at = NULL`.
			const createStatus = status === "scheduled" ? "draft" : status;

			// Build data object with required fields. The title and excerpt as
			// WordPress printed them (the_title and the_excerpt run wptexturize),
			// like the content; the slug above is the stored title's.
			const typed = (text: string) => (texturize ? wptexturize(text) : text);
			const data: Record<string, unknown> = {
				title: typed(post.title || "Untitled"),
				content,
				excerpt: post.excerpt ? typed(post.excerpt) : undefined,
				...mappedData,
			};

			// Only add featured_image if the collection has this field and we have a value
			const collectionSchema = manifest.collections[collection];
			const hasFeaturedImageField = collectionSchema?.fields
				? "featured_image" in collectionSchema.fields
				: false;
			if (hasFeaturedImageField) {
				const thumbnailId = post.meta.get("_thumbnail_id");
				const featuredImage = thumbnailId ? attachmentMap.get(String(thumbnailId)) : undefined;
				if (featuredImage) {
					data.featured_image = featuredImage;
				}
			}

			// Resolve author ID from mappings
			let authorId: string | undefined;
			if (config.authorMappings && post.creator) {
				const mappedUserId = config.authorMappings[post.creator];
				if (mappedUserId !== undefined && mappedUserId !== null) {
					authorId = mappedUserId;
				}
			}

			// Preserve original WordPress dates using the shared WXR date parser.
			// Fallback chain: postDateGmt (UTC) → pubDate (RFC 2822) → postDate (site-local).
			const createdAt = parsedDate ? parsedDate.toISOString() : undefined;
			const publishedAt = createStatus === "published" && createdAt ? createdAt : undefined;

			if (useAtomic && emdash.handleContentCreateAtomicWxr && atomicTaxonomyState) {
				const sourcePostId =
					post.id !== undefined ? String(post.id) : `missing:${postIndex}:${slug}`;
				const canonicalLocale = resolveContentCreateLocale(postLocale);
				const atomicStatus: "draft" | "published" | "scheduled" =
					status === "scheduled" && scheduledMoment.date
						? "scheduled"
						: status === "published"
							? "published"
							: "draft";
				const atomicScheduledAt =
					atomicStatus === "scheduled" && scheduledMoment.date
						? scheduledMoment.date.toISOString()
						: undefined;
				const atomicSeo = seo && collectionHasSeo && hasWxrSeo(seo) ? seo.seo : undefined;
				const protectionFingerprint = protection.protection
					? {
							version: protection.protection.version,
							mode: "protected",
							verifier: protection.protection.verifier,
						}
					: protection.protected
						? { mode: protection.unrecoverable ? "password-unrecoverable" : "password-protected" }
						: null;

				const sourceAuthor: WxrSourceAuthor | undefined = post.creator
					? {
							key: post.creator,
							displayName: authorDisplayNames?.get(post.creator) || post.creator,
							mappedUserId: typeof authorId === "string" ? authorId : undefined,
						}
					: undefined;
				// Pure source inputs: no destination reads or generated IDs.
				const sourceTerms = canonicalSourceTermIdentities(
					post,
					atomicTaxonomyState.wxrMetaByNameSlug,
				);
				const commentSourcePost = config.protections?.[String(post.id)]
					? { ...post, postPassword: "redacted" }
					: post;
				const preparedComments =
					config.importComments !== false
						? prepareWxrPostComments(commentSourcePost, texturize)
						: { comments: [], notCarried: {} };

				// Fingerprint STABLE SOURCE INPUTS ONLY (before any DB taxonomy/byline writes,
				// before wall-clock status transitions, and before Portable Text random `_key`s).
				const inputFingerprint = `v1:${await sha256Hex(
					canonicalJson({
						siteLink: options?.siteLink ?? null,
						collection,
						sourcePostId,
						sourceTranslationGroup: post.translationGroup ?? null,
						slug,
						locale: canonicalLocale,
						wpStatus: post.status ?? null,
						postDateGmt: post.postDateGmt ?? null,
						pubDate: post.pubDate ?? null,
						postDate: post.postDate ?? null,
						protection: protectionFingerprint,
						title: data.title ?? null,
						rawContent: post.content ?? "",
						excerpt: data.excerpt ?? null,
						featuredImage: data.featured_image ?? null,
						mappedData,
						mappedEmbed: mappedEmbed ?? null,
						sourceAuthor: sourceAuthor ?? null,
						seo: atomicSeo ?? null,
						sourceTerms,
						importComments: config.importComments !== false,
						commentTexturize: texturize,
						comments: canonicalCommentsPlan(preparedComments.comments),
					}),
				)}`;

				// 1. ONE read-only receipt decision BEFORE any taxonomy/byline/comment/content writes.
				const atomicRepo = new AtomicWxrImportRepository(emdash.db);
				const existingReceipt = await atomicRepo.findReceipt(
					effectiveSourceLineage,
					sourcePostId,
					canonicalLocale,
				);
				if (existingReceipt) {
					if (existingReceipt.collection !== collection) {
						if (post.translationGroup) {
							blockedTranslationGroups.add(post.translationGroup);
						}
						result.errors.push({
							title: post.title || "Untitled",
							error: `Source "${sourcePostId}" (${canonicalLocale}) was already imported into "${existingReceipt.collection}", not "${collection}"`,
						});
						continue;
					}
					if (existingReceipt.input_fingerprint !== inputFingerprint) {
						// Changed anchor grants ZERO custody (no comments, no translation authority).
						if (post.translationGroup) {
							blockedTranslationGroups.add(post.translationGroup);
						}
						result.changed = (result.changed ?? 0) + 1;
						result.items?.push({
							collection: existingReceipt.collection,
							id: existingReceipt.entry_id,
							slug: existingReceipt.slug,
							locale: existingReceipt.locale,
							translationGroup: existingReceipt.translation_group,
							status: existingReceipt.status,
							operationId: existingReceipt.operation_id,
							sourcePostId: existingReceipt.source_post_id,
							storedDataHash: existingReceipt.stored_data_hash,
							committedHash: existingReceipt.committed_hash,
							outcome: "changed",
						});
						continue;
					}
					// Replay: ZERO durable source writes, ZERO hooks, ZERO comments.
					// Cheap derived-cache/index recovery if a prior cut lost the post-commit flush.
					if (!incrementalCaptureActive) {
						const existingUsageSource = await emdash.db
							.selectFrom("_emdash_media_usage_sources")
							.select("source_key")
							.where("collection_slug", "=", collection)
							.where("content_id", "=", existingReceipt.entry_id)
							.executeTakeFirst();
						if (!existingUsageSource) {
							await emdash.handleContentCreateAtomicWxr(
								collection,
								{
									sourceLineage: effectiveSourceLineage,
									sourcePostId,
									sourceGroupId: post.translationGroup,
									inputFingerprint,
									data,
									slug,
									status: atomicStatus,
									locale: canonicalLocale,
									terms: [],
								},
								{ skipMediaUsageRefresh: false },
							);
						}
					}
					invalidateCollectionCache(collection);
					result.skipped++;
					result.items?.push({
						collection: existingReceipt.collection,
						id: existingReceipt.entry_id,
						slug: existingReceipt.slug,
						locale: existingReceipt.locale,
						translationGroup: existingReceipt.translation_group,
						status: existingReceipt.status,
						operationId: existingReceipt.operation_id,
						sourcePostId: existingReceipt.source_post_id,
						storedDataHash: existingReceipt.stored_data_hash,
						committedHash: existingReceipt.committed_hash,
						outcome: "replayed",
					});
					if (post.translationGroup && !translationGroupMap.has(post.translationGroup)) {
						translationGroupMap.set(post.translationGroup, existingReceipt.entry_id);
					}
					continue;
				}

				// 2. Read-only existing slug check BEFORE blockedTranslationGroups so a
				// 1-byte fallback re-export skips BOTH existing translation siblings cleanly
				// with zero writes and zero errors, while a NEW sibling still refuses below.
				const existingBySlug = await contentRepo.findBySlug(collection, slug, canonicalLocale);
				if (existingBySlug) {
					result.skipped++;
					if (post.translationGroup) {
						blockedTranslationGroups.add(post.translationGroup);
					}
					continue;
				}

				// 3. Refuse any NEW sibling whose translation anchor was skipped, changed, or
				// conflicted — never let it detach into a standalone row.
				if (
					post.translationGroup &&
					!translationOf &&
					blockedTranslationGroups.has(post.translationGroup)
				) {
					result.errors.push({
						title: post.title || "Untitled",
						error: `Translation anchor for source group "${post.translationGroup}" was skipped, changed, or conflicted; sibling refused`,
					});
					continue;
				}

				// 4. NEW item only: plan taxonomy writes.
				let plannedTerms: ReturnType<typeof planAtomicPostTaxonomies>;
				try {
					plannedTerms = planAtomicPostTaxonomies(
						atomicTaxonomyState,
						collection,
						post,
						canonicalLocale,
						canonicalDefaultLocale,
						atomicPostLocales,
					);
				} catch (taxErr) {
					if (post.translationGroup) {
						blockedTranslationGroups.add(post.translationGroup);
					}
					result.errors.push({
						title: post.title || "Untitled",
						error: isWxrTaxonomyConflictError(taxErr)
							? taxErr.publicMessage
							: taxErr instanceof Error
								? taxErr.message
								: "Failed to plan taxonomies",
					});
					continue;
				}

				const atomicResult = await emdash.handleContentCreateAtomicWxr(
					collection,
					{
						sourceLineage: effectiveSourceLineage,
						sourcePostId,
						sourceGroupId: post.translationGroup,
						inputFingerprint,
						data,
						protection: protection.protection,
						slug,
						status: atomicStatus,
						authorId: sourceAuthor?.mappedUserId,
						sourceAuthor,
						locale: canonicalLocale,
						seo: atomicSeo,
						translationOf,
						terms: plannedTerms.pivots,
						pendingTerms:
							plannedTerms.pendingTerms.length > 0 ? plannedTerms.pendingTerms : undefined,
						expectedTerms: plannedTerms.expectedTerms,
						replaceTaxonomies: translationOf ? plannedTerms.carriedTaxonomies : undefined,
						pendingComments:
							config.importComments !== false && preparedComments.comments.length > 0
								? preparedComments.comments
								: undefined,
						createdAt,
						publishedAt: atomicStatus === "published" ? createdAt : undefined,
						scheduledAt: atomicScheduledAt,
					},
					{ skipMediaUsageRefresh: incrementalCaptureActive },
				);

				if (!atomicResult.success || !atomicResult.data) {
					if (post.translationGroup) {
						blockedTranslationGroups.add(post.translationGroup);
					}
					result.errors.push({
						title: post.title || "Untitled",
						error: atomicResult.error?.message || "Atomic WXR import failed",
					});
					continue;
				}

				const applied = atomicResult.data;
				if (applied.outcome === "created") {
					result.imported++;
					result.byCollection[collection] = (result.byCollection[collection] || 0) + 1;
					for (const c of post.containers ?? []) {
						if (c.outcome === "kept") {
							containerTally.set(
								c.blockName ?? "unknown",
								(containerTally.get(c.blockName ?? "unknown") ?? 0) + 1,
							);
							for (const dropped of c.droppedNoMarkup ?? []) {
								droppedNoMarkupTally.set(dropped, (droppedNoMarkupTally.get(dropped) ?? 0) + 1);
							}
						} else flatContainers += 1;
					}
					result.items?.push(applied.receipt);
					if (plannedTerms.pendingTerms.length > 0) {
						recordCommittedAtomicTerms(atomicTaxonomyState, plannedTerms.pendingTerms);
					}
					if (post.translationGroup && !translationGroupMap.has(post.translationGroup)) {
						translationGroupMap.set(post.translationGroup, applied.receipt.id);
					}
					if (result.taxonomies) {
						result.taxonomies.assignments += plannedTerms.pivots.length;
					}
					if (result.comments && config.importComments !== false) {
						result.comments.imported += preparedComments.comments.length;
						for (const [reason, count] of Object.entries(preparedComments.notCarried)) {
							result.comments.notCarried[reason] =
								(result.comments.notCarried[reason] ?? 0) + count;
						}
					}
					for (const warning of converted.warnings) {
						result.errors.push({ title: post.title || "Untitled", error: warning });
					}
					if (protection.protected && !protection.protection) {
						(result.drafted ??= []).push({
							title: post.title || "Untitled",
							reason: protection.unrecoverable ? "password-unrecoverable" : "password-protected",
						});
					}
					if (
						post.status === "future" &&
						scheduledMoment.unzonedLocalOnly &&
						!(protection.protected && !protection.protection)
					) {
						result.errors.push({
							title: post.title || "Untitled",
							error: "scheduled time has no timezone (only site-local post_date); kept as draft",
						});
					}
					if (seoTally && seo) {
						if (collectionHasSeo) tallyWxrSeo(seoTally, seo);
						else tallyWxrSeoNoCollection(seoTally, seo);
					}
					if (incrementalCaptureActive) {
						createdWithDeferredUsage++;
					}
					createdSinceFlush++;
					if (epochFlushInterval > 0 && createdSinceFlush >= epochFlushInterval) {
						flushCoalescedObjectCacheWrites();
						createdSinceFlush = 0;
					}
				} else if (applied.outcome === "replayed") {
					invalidateCollectionCache(collection);
					result.skipped++;
					result.items?.push(applied.receipt);
					if (post.translationGroup && !translationGroupMap.has(post.translationGroup)) {
						translationGroupMap.set(post.translationGroup, applied.receipt.id);
					}
				} else if (applied.outcome === "changed") {
					result.changed = (result.changed ?? 0) + 1;
					result.items?.push(applied.receipt);
					if (post.translationGroup) {
						blockedTranslationGroups.add(post.translationGroup);
					}
				} else if (applied.outcome === "skipped") {
					// A skipped (unreceipted or wrong-source) slug grants ZERO custody.
					result.skipped++;
					if (post.translationGroup) {
						blockedTranslationGroups.add(post.translationGroup);
					}
				} else if (applied.outcome === "conflict") {
					if (post.translationGroup) {
						blockedTranslationGroups.add(post.translationGroup);
					}
					result.errors.push({
						title: post.title || "Untitled",
						error: applied.reason,
					});
				} else {
					if (post.translationGroup) {
						blockedTranslationGroups.add(post.translationGroup);
					}
					result.errors.push({
						title: post.title || "Untitled",
						error: applied.message,
					});
				}
				continue;
			}

			const bylineId = await resolveImportByline(
				post.creator,
				authorDisplayNames?.get(post.creator ?? "") ?? post.creator,
				authorId,
				bylineRepo,
				bylineCache,
			);

			// Create the content item (defer per-row media usage refresh only when
			// durable incremental DB capture triggers are active; otherwise keep the
			// immediate synchronous path so interrupted imports never lose usage).
			const createResult = await emdash.handleContentCreate(
				collection,
				{
					data,
					protection: protection.protection,
					slug,
					status: createStatus,
					authorId,
					bylines: bylineId ? [{ bylineId }] : undefined,
					locale: postLocale,
					translationOf,
					createdAt,
					publishedAt,
					seo: seo && collectionHasSeo && hasWxrSeo(seo) ? seo.seo : undefined,
				},
				{ skipMediaUsageRefresh: incrementalCaptureActive },
			);

			if (createResult.success) {
				result.imported++;
				for (const warning of converted.warnings) {
					result.errors.push({ title: post.title || "Untitled", error: warning });
				}
				if (protection.protected && !protection.protection) {
					(result.drafted ??= []).push({
						title: post.title || "Untitled",
						reason: protection.unrecoverable ? "password-unrecoverable" : "password-protected",
					});
				}
				if (seoTally && seo) {
					if (collectionHasSeo) tallyWxrSeo(seoTally, seo);
					else tallyWxrSeoNoCollection(seoTally, seo);
				}
				result.byCollection[collection] = (result.byCollection[collection] || 0) + 1;
				for (const c of post.containers ?? []) {
					if (c.outcome === "kept") {
						containerTally.set(
							c.blockName ?? "unknown",
							(containerTally.get(c.blockName ?? "unknown") ?? 0) + 1,
						);
						for (const dropped of c.droppedNoMarkup ?? []) {
							droppedNoMarkupTally.set(dropped, (droppedNoMarkupTally.get(dropped) ?? 0) + 1);
						}
					} else flatContainers += 1;
				}

				// `handleContentCreate` returns `data: { item, _rev? }` on
				// success (see `ApiResult<ContentResponse>` in
				// `api/handlers/content.ts`). `HandlerResponse.data` is
				// typed as `unknown` to avoid coupling the route surface to
				// internal handler types, so we narrow here.
				const createdItem = readCreatedItem(createResult.data);

				if (createdItem) {
					stored(post, collection, createdItem.id);
					const preloaded = existingByCollection.get(collection);
					if (preloaded) {
						recordExisting(
							preloaded,
							createdItem.slug ?? slug,
							createdItem.locale ?? postLocale ?? defaultLocale,
							createdItem.id,
						);
					}
					if (incrementalCaptureActive) {
						createdWithDeferredUsage++;
					}
					createdSinceFlush++;
					if (epochFlushInterval > 0 && createdSinceFlush >= epochFlushInterval) {
						flushCoalescedObjectCacheWrites();
						createdSinceFlush = 0;
					}
				}

				// A SCHEDULED POST CARRIES ITS MOMENT. The row was created as `draft`,
				// and `handleContentSchedule` transitions `draft -> scheduled` with
				// `scheduled_at` atomically. If scheduling fails (or the WXR only had
				// an unzoned local `post_date`), the row stays a real `draft` and is named.
				if (
					createdItem &&
					post.status === "future" &&
					scheduledMoment.unzonedLocalOnly &&
					!(protection.protected && !protection.protection)
				) {
					result.errors.push({
						title: post.title || "Untitled",
						error: "scheduled time has no timezone (only site-local post_date); kept as draft",
					});
				} else if (createdItem && status === "scheduled" && scheduledMoment.date) {
					const scheduled = await emdash.handleContentSchedule(
						collection,
						createdItem.id,
						scheduledMoment.date.toISOString(),
					);
					if (!scheduled.success) {
						result.errors.push({
							title: post.title || "Untitled",
							error: `scheduled for ${scheduledMoment.date.toISOString()} but the schedule could not be set (${scheduled.error?.message ?? "unknown"}); it is a draft`,
						});
					}
				}

				// Track translation group: the first imported post in a group
				// becomes the anchor that later translations link to.
				if (
					createdItem &&
					post.translationGroup &&
					!translationGroupMap.has(post.translationGroup)
				) {
					translationGroupMap.set(post.translationGroup, createdItem.id);
				}

				// Attach taxonomy assignments parsed from the WXR's per-item
				// <category> elements.
				//
				// Anchors (no `translationOf`) get an additive attach -- the
				// row is fresh, no inherited pivots to consider.
				//
				// Translations replace only taxonomies they explicitly carry.
				// Since assignments belong to the content translation_group,
				// that replacement is reflected in every sibling locale.
				if (createdItem && taxonomyPlan) {
					try {
						const written = translationOf
							? await setPostTermAssignmentsReplacing(
									emdash.db,
									collection,
									createdItem.id,
									post,
									taxonomyPlan,
								)
							: await attachPostTaxonomies(
									emdash.db,
									collection,
									createdItem.id,
									post,
									taxonomyPlan,
								);
						if (result.taxonomies) {
							result.taxonomies.assignments += written;
						}
					} catch (taxError) {
						console.error(
							`Failed to attach taxonomies for "${post.title || "Untitled"}":`,
							taxError,
						);
						result.errors.push({
							title: post.title || "Untitled",
							error:
								taxError instanceof Error && taxError.message
									? `Imported but failed to attach taxonomies: ${taxError.message}`
									: "Imported but failed to attach taxonomies",
						});
					}
				}
			} else {
				result.errors.push({
					title: post.title || "Untitled",
					error:
						typeof createResult.error === "object" && createResult.error !== null
							? (createResult.error as { message?: string }).message || "Unknown error"
							: String(createResult.error),
				});
			}
		} catch (error) {
			console.error(`Import error for "${post.title || "Untitled"}":`, error);
			result.errors.push({
				title: post.title || "Untitled",
				error: error instanceof Error && error.message ? error.message : "Failed to import item",
			});
		}
	}

	if (!useAtomic && config.importComments !== false) {
		const comments = await importWxrComments(
			posts.map((post) =>
				config.protections?.[String(post.id)] ? { ...post, postPassword: "redacted" } : post,
			),
			emdash.db,
			contentIdByWpId,
			collectionByWpId,
			(post) => texturizes(post.locale ?? siteLanguage, generator),
		);
		result.comments = {
			imported: comments.imported,
			skipped: comments.skipped,
			notCarried: comments.notCarried,
		};
		for (const e of comments.errors) {
			result.errors.push({ title: `Comment: ${e.comment}`, error: e.error });
		}
	}

	// Any execute that returns bumps every enabled collection plus taxonomies
	// and bylines once, even if this retry skipped all rows committed by an
	// earlier cut attempt.
	for (const col of enabledCollections) {
		invalidateCollectionCache(col);
	}
	invalidateTaxonomyObjectCache();
	invalidateBylineObjectCache();

	if (createdWithDeferredUsage > 0) {
		// Durable debt is already recorded in _emdash_media_usage_work by the
		// active incremental capture DB triggers; after() is an accelerator.
		after(async () => {
			await processDueMediaUsageWork(emdash.db);
		});
	}

	result.success = result.errors.length === 0;

	// Item 163c/163d: kept vs flat container counts, plus any childless no-markup blocks dropped inside kept containers.
	if (containerTally.size > 0 || flatContainers > 0) {
		const droppedNoMarkup = Array.from(droppedNoMarkupTally, ([blockName, count]) => ({
			blockName,
			count,
		})).toSorted((a, b) => b.count - a.count);
		result.containers = {
			kept: Array.from(containerTally, ([plugin, count]) => ({ plugin, count })).toSorted(
				(a, b) => b.count - a.count,
			),
			flat: flatContainers,
			...(droppedNoMarkup.length > 0 ? { droppedNoMarkup } : {}),
		};
	}
	return result;
}

/**
 * Atomic per-section (`wp_block`) importer. Gives each reusable section its own
 * receipt in `_emdash_wxr_import_receipts` (`collection = "_emdash_sections"`)
 * committed in ONE atomic D1 `.batch()` / SQLite transaction with `_emdash_sections`.
 */
async function importReusableBlocksAsSectionsAtomic(
	posts: WxrPost[],
	db: EmDashHandlers["db"],
	sourceLineage: string,
	canonicalLocale: string,
	result: ImportResult,
): Promise<void> {
	const reusableBlocks = posts.filter((post) => post.postType === "wp_block");
	const summary = { created: 0, skipped: 0 };
	if (reusableBlocks.length === 0) {
		result.sections = summary;
		return;
	}

	const atomicRepo = new AtomicWxrImportRepository(db);
	for (const [idx, block] of reusableBlocks.entries()) {
		const title = block.title || "Untitled Block";
		const slug =
			block.postName ||
			slugify(block.title || `block-${block.id !== undefined ? block.id : `item-${idx}`}`);
		const sourcePostId =
			block.id !== undefined ? `section:${block.id}` : `section:missing:${idx}:${slug}`;
		const inputFingerprint = `v1:${await sha256Hex(
			canonicalJson({
				slug,
				title,
				rawContent: block.content ?? "",
			}),
		)}`;
		const content = block.content ? gutenbergToPortableText(block.content) : [];

		const applied = await atomicRepo.applySectionCreate({
			sourceLineage,
			sourcePostId,
			slug,
			locale: canonicalLocale,
			title,
			contentJson: JSON.stringify(content),
			inputFingerprint,
		});

		if (applied.outcome === "created") {
			summary.created++;
			result.items?.push(applied.receipt);
		} else if (applied.outcome === "replayed") {
			invalidateCollectionCache("_emdash_sections");
			summary.skipped++;
			result.items?.push(applied.receipt);
		} else if (applied.outcome === "changed") {
			result.changed = (result.changed ?? 0) + 1;
			result.items?.push(applied.receipt);
		} else if (applied.outcome === "skipped") {
			summary.skipped++;
		} else if (applied.outcome === "conflict") {
			result.errors.push({ title, error: applied.reason });
			result.success = false;
		} else {
			result.errors.push({ title, error: applied.message });
			result.success = false;
		}
	}
	result.sections = summary;
}

/**
 * What the per-post SEO pass reads: the site identity, the export's media and
 * the path each enabled item will have in EmDash, so a canonical that names
 * another imported entry can point at its new URL. Items whose collection
 * pattern needs the row id get no path.
 */
export function wxrSeoContext(
	wxr: Pick<WxrData, "site" | "posts" | "attachments">,
	config: ImportConfig,
	manifest: EmDashManifest,
): WxrSeoSite {
	const site = wxrSeoSite(wxr.site, wxr.attachments, new Map());
	const paths = new Map<string, string>();
	for (const post of wxr.posts) {
		const mapping = config.postTypeMappings[post.postType || "post"];
		if (!mapping?.enabled || !post.link) continue;
		const collection = sanitizeSlug(mapping.collection);
		const schema = manifest.collections[collection];
		const slug = post.postName || (post.title ? slugify(post.title) : "");
		if (!schema || !slug || schema.urlPattern?.includes("{id}")) continue;
		const path = interpolateUrlPattern({
			pattern: schema.urlPattern ?? null,
			collection,
			slug,
			id: "",
			date: parseWxrDate(post.postDateGmt, post.pubDate, post.postDate),
		});
		const key = wxrUrlKey(post.link, site.link);
		if (key && !paths.has(key)) paths.set(key, path);
	}
	return { ...site, entryPaths: paths };
}

/**
 * WordPress's status, as EmDash's.
 *
 * `future` IS A SCHEDULED POST, and it used to fall to `default: "draft"` — so a
 * site's whole scheduled calendar arrived as drafts with no date, and the
 * operator had to find and re-schedule each one by hand.
 *
 * A `future` post whose moment is still ahead becomes `scheduled` with that
 * moment. A `future` post whose moment has PASSED is a missed schedule:
 * WordPress publishes it on its next cron run, so it is `published` here.
 *
 * `pending` and `private` stay `draft`: neither is public, and a private post is
 * admins-only, which a draft is the honest EmDash shape of.
 */
export function mapStatus(
	wpStatus: string | undefined,
	scheduledAt?: Date | null,
	now: Date = new Date(),
): string {
	switch (wpStatus) {
		case "publish":
			return "published";
		case "future":
			// A MISSED SCHEDULE IS PUBLISHED: WordPress's cron would have published it.
			if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) return "draft";
			return scheduledAt.getTime() > now.getTime() ? "scheduled" : "published";
		case "draft":
			return "draft";
		case "pending":
			return "draft";
		case "private":
			return "draft";
		default:
			return "draft";
	}
}
