/**
 * Atomic per-post WXR import repository (Item 132).
 *
 * Commits a single WXR post's content row, protection, bylines, SEO, taxonomy
 * pivots, mutable translation-group CAS baseline, and immutable create receipt
 * in ONE atomic D1 `.batch()` (or real SQLite/Postgres transaction), refusing
 * adapters that offer neither.
 */

import { PostgresAdapter, SqliteAdapter, sql, type Kysely, type RawBuilder } from "kysely";
import { ulid } from "ulidx";

import type { ContentProtection } from "../../content/protection.js";
import {
	invalidateBylineObjectCache,
	invalidateCollectionCache,
} from "../../object-cache/index.js";
import { invalidateTermCache } from "../../taxonomies/index.js";
import { executeAtomicBatchIfSupported, isPostgres } from "../dialect-helpers.js";
import type { Database, WxrGroupBaselineTable, WxrImportReceiptTable } from "../types.js";
import { validateIdentifier } from "../validate.js";
import { BylineRepository, type ContentBylineInput } from "./byline.js";
import { ContentRepository } from "./content.js";
import { SeoRepository } from "./seo.js";
import type { ContentSeoInput } from "./types.js";

/** Advertised on WXR analyze when atomic per-post WXR import receipts are active. */
export const WXR_ATOMIC_IMPORT_CAPABILITY = "emdash.wxr-atomic-import.v1" as const;

/** Cloudflare D1 statement limits (developers.cloudflare.com/d1/platform/limits). */
export const D1_MAX_BINDS_PER_STATEMENT = 100;
export const D1_MAX_SQL_BYTES = 100_000;
export const D1_MAX_VALUE_BYTES = 2_000_000;

/** 3 columns per content_taxonomies pivot -> max 30 rows (90 <= 100 D1 bind limit). */
const TAXONOMY_PIVOT_CHUNK_SIZE = 30;

export interface WxrTermPivot {
	taxonomy: string;
	termGroup: string;
}

export interface AtomicWxrCreateInput {
	sourceLineage: string;
	sourcePostId: string;
	/** Source-side translation group ID (e.g. WPML/Polylang trid) bound to the group baseline. */
	sourceGroupId?: string;
	collection: string;
	slug: string;
	locale: string;
	status: "draft" | "published" | "scheduled";
	data: Record<string, unknown>;
	authorId?: string;
	bylines?: ContentBylineInput[];
	seo?: ContentSeoInput;
	hasSeo: boolean;
	protection?: ContentProtection;
	createdAt?: string;
	publishedAt?: string;
	scheduledAt?: string;
	translationOf?: string;
	inheritFields?: string[];
	/** Resolved term pivots to attach (for anchors) or replace per taxonomy (for translations). */
	terms: readonly WxrTermPivot[];
	/** Carried taxonomy names whose pivots should be replaced on translation creates. */
	replaceTaxonomies?: readonly string[];
	/** Opaque SHA-256 fingerprint of the canonical WXR item + import config/plan. */
	inputFingerprint: string;
	/** Test-only hook to force the final SQL integrity assertion to fail and roll back. */
	_forceAssertionFailure?: boolean;
	/** Test-only hook invoked right before executing the atomic batch/transaction. */
	_beforeCommit?: () => Promise<void>;
}

export interface AtomicWxrItemReceipt {
	collection: string;
	id: string;
	slug: string;
	locale: string;
	translationGroup: string;
	status: string;
	operationId: string;
	sourcePostId: string;
	storedDataHash: string;
	committedHash: string;
	outcome: "created" | "replayed" | "changed";
}

export type AtomicWxrApplyResult =
	| { outcome: "created"; receipt: AtomicWxrItemReceipt }
	| { outcome: "replayed"; receipt: AtomicWxrItemReceipt }
	| { outcome: "changed"; receipt: AtomicWxrItemReceipt; reason: string }
	| { outcome: "skipped"; reason: string; existingId: string }
	| { outcome: "conflict"; reason: string }
	| { outcome: "error"; code: string; message: string };

const utf8Encoder = new TextEncoder();

/**
 * Returns true iff `db` supports either atomic D1 `.batch()` or a real
 * SQLite/Postgres transaction (refusing adapters that offer neither).
 */
export function supportsAtomicWxrImport(db: Kysely<Database>): boolean {
	const adapter = db.getExecutor().adapter;
	if ("executeAtomicBatch" in adapter && typeof adapter.executeAtomicBatch === "function") {
		return true;
	}
	if (adapter instanceof PostgresAdapter) return true;
	if (adapter instanceof SqliteAdapter && adapter.constructor === SqliteAdapter) {
		return true;
	}
	return false;
}

/** Deterministic JSON serialization (sorted object keys) for stable hashes/fingerprints. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
	}
	const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const parts: string[] = [];
	for (const [key, val] of entries) {
		if (val === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${canonicalJson(val)}`);
	}
	return `{${parts.join(",")}}`;
}

/** Compute a lowercase hex SHA-256 digest via Web Crypto (native in Node 22 & workerd). */
export async function sha256Hex(input: string): Promise<string> {
	const bytes = utf8Encoder.encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Versioned stored-data digest (v1:sha256) kept separate from internal guard digests. */
export async function computeStoredDataHash(data: Record<string, unknown>): Promise<string> {
	return `v1:${await sha256Hex(canonicalJson(data))}`;
}

function canonicalTermsKey(terms: readonly WxrTermPivot[]): string {
	const deduped = new Map<string, WxrTermPivot>();
	for (const t of terms) {
		deduped.set(`${t.taxonomy}\0${t.termGroup}`, t);
	}
	return JSON.stringify(
		[...deduped.values()].toSorted(
			(a, b) => a.taxonomy.localeCompare(b.taxonomy) || a.termGroup.localeCompare(b.termGroup),
		),
	);
}

/** Sorted CSV of distinct taxonomy_id values matching SQLite BINARY / Postgres C ORDER BY. */
function canonicalTermGroupCsv(terms: readonly WxrTermPivot[]): string {
	const groups = [...new Set(terms.map((t) => t.termGroup))].toSorted((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	return groups.join(",");
}

/** Ordered canonical string of an entry's byline credits (`sort_order:byline_id:role_label`). */
function canonicalBylinesKey(
	credits: ReadonlyArray<{ group: string; roleLabel: string | null; sortOrder: number }>,
): string {
	return credits.map((c) => `${c.sortOrder}:${c.group}:${c.roleLabel ?? ""}`).join("|");
}

interface BaselineSeoSnapshot {
	title: string;
	description: string;
	image: string;
	canonical: string;
	noIndex: number;
	updatedAt: string;
}

function serializeSeoSnapshot(seo: ContentSeoInput | undefined, updatedAt: string): string | null {
	if (!seo) return null;
	const snapshot: BaselineSeoSnapshot = {
		title: seo.title ?? "",
		description: seo.description ?? "",
		image: seo.image ?? "",
		canonical: seo.canonical ?? "",
		noIndex: seo.noIndex ? 1 : 0,
		updatedAt,
	};
	return JSON.stringify(snapshot);
}

function parseSeoSnapshot(raw: string | null): BaselineSeoSnapshot | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (
			"title" in parsed &&
			typeof parsed.title === "string" &&
			"description" in parsed &&
			typeof parsed.description === "string" &&
			"image" in parsed &&
			typeof parsed.image === "string" &&
			"canonical" in parsed &&
			typeof parsed.canonical === "string" &&
			"noIndex" in parsed &&
			typeof parsed.noIndex === "number" &&
			"updatedAt" in parsed &&
			typeof parsed.updatedAt === "string"
		) {
			return {
				title: parsed.title,
				description: parsed.description,
				image: parsed.image,
				canonical: parsed.canonical,
				noIndex: parsed.noIndex,
				updatedAt: parsed.updatedAt,
			};
		}
		return null;
	} catch {
		return null;
	}
}

function parseTermsJson(raw: string): WxrTermPivot[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: WxrTermPivot[] = [];
		for (const item of parsed) {
			if (
				typeof item === "object" &&
				item !== null &&
				"taxonomy" in item &&
				typeof item.taxonomy === "string" &&
				"termGroup" in item &&
				typeof item.termGroup === "string"
			) {
				out.push({ taxonomy: item.taxonomy, termGroup: item.termGroup });
			}
		}
		return out;
	} catch {
		return [];
	}
}

function validateCompiledD1Limits(
	db: Kysely<Database>,
	queries: readonly RawBuilder<unknown>[],
): string | null {
	for (const [i, query] of queries.entries()) {
		const compiled = query.compile(db);
		if (compiled.parameters.length > D1_MAX_BINDS_PER_STATEMENT) {
			return `Atomic import statement ${i} has ${compiled.parameters.length} binds (limit ${D1_MAX_BINDS_PER_STATEMENT})`;
		}
		const sqlBytes = utf8Encoder.encode(compiled.sql).byteLength;
		if (sqlBytes > D1_MAX_SQL_BYTES) {
			return `Atomic import statement ${i} SQL size ${sqlBytes} bytes exceeds D1 limit (${D1_MAX_SQL_BYTES})`;
		}
		for (const param of compiled.parameters) {
			if (typeof param === "string") {
				const bytes = utf8Encoder.encode(param).byteLength;
				if (bytes > D1_MAX_VALUE_BYTES) {
					return `Atomic import value size ${bytes} bytes exceeds D1 limit (${D1_MAX_VALUE_BYTES})`;
				}
			} else if (param instanceof Uint8Array && param.byteLength > D1_MAX_VALUE_BYTES) {
				return `Atomic import binary value size ${param.byteLength} bytes exceeds D1 limit (${D1_MAX_VALUE_BYTES})`;
			}
		}
	}
	return null;
}

function receiptRowToItem(
	row: WxrImportReceiptTable,
	outcome: "created" | "replayed" | "changed",
): AtomicWxrItemReceipt {
	return {
		collection: row.collection,
		id: row.entry_id,
		slug: row.slug,
		locale: row.locale,
		translationGroup: row.translation_group,
		status: row.status,
		operationId: row.operation_id,
		sourcePostId: row.source_post_id,
		storedDataHash: row.stored_data_hash,
		committedHash: row.committed_hash,
		outcome,
	};
}

function classifyExistingReceipt(
	row: WxrImportReceiptTable,
	collection: string,
	inputFingerprint: string,
	sourcePostId: string,
	locale: string,
): AtomicWxrApplyResult {
	if (row.collection !== collection) {
		return {
			outcome: "conflict",
			reason: `Source "${sourcePostId}" (${locale}) was already imported into "${row.collection}", not "${collection}"`,
		};
	}
	if (row.input_fingerprint !== inputFingerprint) {
		return {
			outcome: "changed",
			receipt: receiptRowToItem(row, "changed"),
			reason: `Source "${sourcePostId}" (${locale}) changed since it was imported and was left as imported`,
		};
	}
	return {
		outcome: "replayed",
		receipt: receiptRowToItem(row, "replayed"),
	};
}

export class AtomicWxrImportRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async findReceipt(
		sourceLineage: string,
		sourcePostId: string,
		locale: string,
	): Promise<WxrImportReceiptTable | undefined> {
		return this.db
			.selectFrom("_emdash_wxr_import_receipts")
			.selectAll()
			.where("source_lineage", "=", sourceLineage)
			.where("source_post_id", "=", sourcePostId)
			.where("locale", "=", locale)
			.executeTakeFirst();
	}

	async findGroupBaseline(
		collection: string,
		translationGroup: string,
	): Promise<WxrGroupBaselineTable | undefined> {
		return this.db
			.selectFrom("_emdash_wxr_group_baselines")
			.selectAll()
			.where("collection", "=", collection)
			.where("translation_group", "=", translationGroup)
			.executeTakeFirst();
	}

	/**
	 * Execute ONE atomic per-post create (content row + protection + bylines +
	 * SEO + taxonomy pivots + mutable group baseline + immutable receipt).
	 */
	async applyCreate(input: AtomicWxrCreateInput): Promise<AtomicWxrApplyResult> {
		validateIdentifier(input.collection, "collection slug");
		if (!supportsAtomicWxrImport(this.db)) {
			return {
				outcome: "error",
				code: "ATOMIC_BATCH_UNSUPPORTED",
				message: "Database adapter supports neither atomic D1 batch nor real transactions",
			};
		}
		const tableName = `ec_${input.collection}`;

		// 1. Replay / changed / conflict check against immutable create receipt (ZERO writes).
		const existingReceipt = await this.findReceipt(
			input.sourceLineage,
			input.sourcePostId,
			input.locale,
		);
		if (existingReceipt) {
			return classifyExistingReceipt(
				existingReceipt,
				input.collection,
				input.inputFingerprint,
				input.sourcePostId,
				input.locale,
			);
		}

		// 2. Legacy / owner / different-source row check: a slug hit WITHOUT a
		// matching receipt skips with ZERO writes to the row or its group.
		// Re-check receipt if a concurrent winner landed between steps 1 and 2.
		const contentRepo = new ContentRepository(this.db);
		const existingBySlug = await contentRepo.findBySlug(input.collection, input.slug, input.locale);
		if (existingBySlug) {
			const racedReceipt = await this.findReceipt(
				input.sourceLineage,
				input.sourcePostId,
				input.locale,
			);
			if (racedReceipt) {
				return classifyExistingReceipt(
					racedReceipt,
					input.collection,
					input.inputFingerprint,
					input.sourcePostId,
					input.locale,
				);
			}
			return {
				outcome: "skipped",
				reason: `Slug "${input.slug}" (${input.locale}) already exists without a matching import receipt`,
				existingId: existingBySlug.id,
			};
		}

		// 3. For translations, load & validate the mutable group CAS baseline.
		let anchorGroup: string | undefined;
		let expectedBaseline: WxrGroupBaselineTable | undefined;
		let baselineTerms: WxrTermPivot[] = [];
		if (input.translationOf) {
			const anchorRow = await contentRepo.findById(input.collection, input.translationOf);
			if (!anchorRow) {
				return {
					outcome: "conflict",
					reason: `Translation anchor "${input.translationOf}" does not exist or was deleted`,
				};
			}
			anchorGroup = anchorRow.translationGroup ?? anchorRow.id;
			expectedBaseline = await this.findGroupBaseline(input.collection, anchorGroup);
			if (!expectedBaseline || expectedBaseline.source_lineage !== input.sourceLineage) {
				return {
					outcome: "conflict",
					reason: `Translation group "${anchorGroup}" has no producer import baseline for this lineage (unreceipted anchor)`,
				};
			}
			if (
				input.sourceGroupId !== undefined &&
				expectedBaseline.source_group_id !== input.sourceGroupId
			) {
				return {
					outcome: "conflict",
					reason: `Translation group "${anchorGroup}" belongs to source group "${expectedBaseline.source_group_id ?? ""}", not "${input.sourceGroupId}"`,
				};
			}
			baselineTerms = parseTermsJson(expectedBaseline.terms_json);
		}

		// 4. Resolve bylines up front via shared BylineRepository preparation (chunked <= 98 binds/stmt).
		const now = new Date().toISOString();
		const entryId = ulid();
		const operationId = ulid();
		const bylineRepo = new BylineRepository(this.db);
		let resolvedBylines: {
			primaryBylineId: string | null;
			credits: Array<{ group: string; roleLabel: string | null; sortOrder: number }>;
			statements: RawBuilder<unknown>[];
		} = {
			primaryBylineId: null,
			credits: [],
			statements: [],
		};
		if (input.bylines && input.bylines.length > 0) {
			resolvedBylines = await bylineRepo.prepareSetContentBylines(
				input.collection,
				entryId,
				input.bylines,
				now,
			);
		} else if (input.translationOf) {
			// Copy anchor's bylines atomically in the same batch using the shared chunked builder.
			const anchorBylines = await this.db
				.selectFrom("_emdash_content_bylines")
				.select(["byline_id", "sort_order", "role_label"])
				.where("collection_slug", "=", input.collection)
				.where("content_id", "=", input.translationOf)
				.orderBy("sort_order", "asc")
				.execute();
			resolvedBylines = bylineRepo.buildContentBylineInserts(
				input.collection,
				entryId,
				anchorBylines.map((b, idx) => ({
					group: b.byline_id,
					roleLabel: b.role_label,
					sortOrder: idx,
				})),
				now,
			);
		}

		// 5. Build DB-side group state guard for translation writes (checked IN the batch).
		const effectiveGroup = anchorGroup ?? entryId;
		const isPg = isPostgres(this.db);
		let groupGuardPredicate: RawBuilder<boolean> | undefined;
		if (expectedBaseline && anchorGroup) {
			const expectedTermsCsv = canonicalTermGroupCsv(baselineTerms);
			const liveTermsCsvExpr = isPg
				? sql`COALESCE((SELECT string_agg(ct.taxonomy_id, ',' ORDER BY ct.taxonomy_id ASC) FROM content_taxonomies AS ct WHERE ct.collection = ${input.collection} AND ct.entry_id = ${anchorGroup}), '')`
				: sql`COALESCE((SELECT group_concat(taxonomy_id, ',') FROM (SELECT ct.taxonomy_id AS taxonomy_id FROM content_taxonomies AS ct WHERE ct.collection = ${input.collection} AND ct.entry_id = ${anchorGroup} ORDER BY ct.taxonomy_id ASC)), '')`;

			const liveAnchorBylinesExpr = isPg
				? sql`COALESCE((SELECT string_agg(cb.sort_order::text || ':' || cb.byline_id || ':' || COALESCE(cb.role_label, ''), '|' ORDER BY cb.sort_order ASC) FROM _emdash_content_bylines AS cb WHERE cb.collection_slug = ${input.collection} AND cb.content_id = ${expectedBaseline.anchor_entry_id}), '')`
				: sql`COALESCE((SELECT group_concat(item, '|') FROM (SELECT CAST(cb.sort_order AS TEXT) || ':' || cb.byline_id || ':' || COALESCE(cb.role_label, '') AS item FROM _emdash_content_bylines AS cb WHERE cb.collection_slug = ${input.collection} AND cb.content_id = ${expectedBaseline.anchor_entry_id} ORDER BY cb.sort_order ASC)), '')`;

			const anchorSeoSnap = parseSeoSnapshot(expectedBaseline.anchor_seo_json);
			const anchorSeoPredicate = anchorSeoSnap
				? sql<boolean>`EXISTS (
					SELECT 1 FROM _emdash_seo AS s
					WHERE s.collection = ${input.collection}
						AND s.content_id = ${expectedBaseline.anchor_entry_id}
						AND COALESCE(s.seo_title, '') = ${anchorSeoSnap.title}
						AND COALESCE(s.seo_description, '') = ${anchorSeoSnap.description}
						AND COALESCE(s.seo_image, '') = ${anchorSeoSnap.image}
						AND COALESCE(s.seo_canonical, '') = ${anchorSeoSnap.canonical}
						AND s.seo_no_index = ${anchorSeoSnap.noIndex}
						AND s.updated_at = ${anchorSeoSnap.updatedAt}
				)`
				: sql<boolean>`NOT EXISTS (
					SELECT 1 FROM _emdash_seo AS s
					WHERE s.collection = ${input.collection}
						AND s.content_id = ${expectedBaseline.anchor_entry_id}
				)`;

			const sourceGroupPredicate =
				input.sourceGroupId !== undefined
					? sql<boolean>`AND gb.source_group_id = ${input.sourceGroupId}`
					: sql<boolean>``;

			// Guard checks IN the batch:
			//  1. Mutable group baseline generation + lineage + source_group_id match
			//  2. Anchor row is unedited (version = 1, updated_at matches baseline)
			//  3. Live content_taxonomies match baseline's exact sorted term_group set
			//  4. Live anchor bylines match baseline's exact ordered byline list
			//  5. Every live row in the group matches a finished receipt of this lineage with
			//     version = 1 & unchanged updated_at, and total count equals baseline generation
			//  6. Anchor public SEO matches snapshot; NO sibling public SEO added, edited, OR deleted
			//  7. NO protected group member had its _emdash_protected_content row deleted or SEO edited
			groupGuardPredicate = sql<boolean>`
				EXISTS (
					SELECT 1 FROM _emdash_wxr_group_baselines AS gb
					WHERE gb.collection = ${input.collection}
						AND gb.translation_group = ${anchorGroup}
						AND gb.source_lineage = ${input.sourceLineage}
						AND gb.generation = ${expectedBaseline.generation}
						${sourceGroupPredicate}
				)
				AND translation_source.version = 1
				AND translation_source.updated_at = ${expectedBaseline.anchor_updated_at}
				AND ${liveTermsCsvExpr} = ${expectedTermsCsv}
				AND ${liveAnchorBylinesExpr} = ${expectedBaseline.anchor_bylines_json}
				AND (
					SELECT COUNT(*) FROM ${sql.ref(tableName)} AS c
					WHERE c.translation_group = ${anchorGroup}
						AND c.deleted_at IS NULL
				) = ${expectedBaseline.generation}
				AND NOT EXISTS (
					SELECT 1 FROM ${sql.ref(tableName)} AS c
					LEFT JOIN _emdash_wxr_import_receipts AS r
						ON r.collection = ${input.collection}
						AND r.entry_id = c.id
						AND r.source_lineage = ${input.sourceLineage}
						AND r.receipt_state = 'finished'
					WHERE c.translation_group = ${anchorGroup}
						AND c.deleted_at IS NULL
						AND (c.version != 1 OR r.operation_id IS NULL OR c.updated_at != r.created_at)
				)
				AND ${anchorSeoPredicate}
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_seo AS s
					INNER JOIN ${sql.ref(tableName)} AS c ON c.id = s.content_id
					LEFT JOIN _emdash_wxr_import_receipts AS r
						ON r.collection = ${input.collection}
						AND r.entry_id = c.id
						AND r.source_lineage = ${input.sourceLineage}
						AND r.receipt_state = 'finished'
					WHERE s.collection = ${input.collection}
						AND c.translation_group = ${anchorGroup}
						AND c.deleted_at IS NULL
						AND (r.operation_id IS NULL OR r.has_seo = 0 OR s.updated_at != r.created_at)
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_wxr_import_receipts AS r
					INNER JOIN ${sql.ref(tableName)} AS c ON c.id = r.entry_id
					WHERE r.collection = ${input.collection}
						AND r.translation_group = ${anchorGroup}
						AND r.source_lineage = ${input.sourceLineage}
						AND r.has_seo = 1
						AND c.deleted_at IS NULL
						AND NOT EXISTS (
							SELECT 1 FROM _emdash_seo AS s
							WHERE s.collection = ${input.collection}
								AND s.content_id = r.entry_id
						)
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_wxr_import_receipts AS r
					INNER JOIN ${sql.ref(tableName)} AS c ON c.id = r.entry_id
					WHERE r.collection = ${input.collection}
						AND r.translation_group = ${anchorGroup}
						AND r.source_lineage = ${input.sourceLineage}
						AND r.has_protected = 1
						AND c.deleted_at IS NULL
						AND NOT EXISTS (
							SELECT 1 FROM _emdash_protected_content AS pc
							WHERE pc.collection = ${input.collection}
								AND pc.content_id = r.entry_id
								AND COALESCE(pc.seo, '') = COALESCE(r.protected_seo_json, '')
						)
				)
			`;
		}

		// 6. Prepare content INSERT (+ protection + visibility bump) via shared ContentRepository.prepareCreate.
		const protectedSeoInput = input.protection && input.hasSeo ? (input.seo ?? null) : null;
		const preparedContent = await contentRepo.prepareCreate({
			id: entryId,
			now,
			type: input.collection,
			slug: input.slug,
			data: input.data,
			protection: input.protection,
			protectedSeo: protectedSeoInput,
			status: input.status,
			authorId: input.authorId,
			primaryBylineId: resolvedBylines.primaryBylineId,
			locale: input.locale,
			translationOf: input.translationOf,
			inheritFields: input.inheritFields,
			createdAt: input.createdAt,
			publishedAt: input.publishedAt,
			scheduledAt: input.status === "scheduled" ? (input.scheduledAt ?? null) : null,
			extraWhere: groupGuardPredicate,
		});

		// 7. Compute post-normalization storedDataHash + next group terms + internal guard digest.
		const storedDataHash = await computeStoredDataHash(preparedContent.normalizedData);
		const carriedSet = new Set(input.replaceTaxonomies ?? []);
		const nextGroupTerms: WxrTermPivot[] = expectedBaseline
			? [
					...baselineTerms.filter((t) => !carriedSet.has(t.taxonomy)),
					...input.terms.filter((t) => carriedSet.has(t.taxonomy)),
				]
			: [...input.terms];
		const nextTermsJson = canonicalTermsKey(nextGroupTerms);
		const wroteUnprotectedSeo = Boolean(input.hasSeo && input.seo && !input.protection);
		const protectedSeoJson = protectedSeoInput ? JSON.stringify(protectedSeoInput) : null;
		const committedHash = await sha256Hex(
			canonicalJson({
				collection: input.collection,
				slug: input.slug,
				locale: input.locale,
				status: input.status,
				scheduledAt: input.scheduledAt ?? null,
				storedDataHash,
				primaryBylineId: resolvedBylines.primaryBylineId,
				seo: input.hasSeo ? (input.seo ?? null) : null,
				terms: nextTermsJson,
			}),
		);

		// 8. Assemble all statements in ONE bounded atomic batch.
		const queries: RawBuilder<unknown>[] = [...preparedContent.queries];

		// Bylines (chunked at 14 rows = 98 binds <= 100 D1 limit)
		queries.push(...resolvedBylines.statements);

		// SEO (unprotected rows only; protected SEO is already written into _emdash_protected_content.seo)
		if (wroteUnprotectedSeo && input.seo) {
			const seoStmt = new SeoRepository(this.db).prepareUpsert(
				input.collection,
				entryId,
				input.seo,
				now,
			);
			if (seoStmt) queries.push(seoStmt);
		}

		// Taxonomy pivots (packed/split inside the same batch for D1's 100-bind limit)
		if (expectedBaseline && anchorGroup && carriedSet.size > 0) {
			const carriedList = [...carriedSet];
			queries.push(sql`
				DELETE FROM content_taxonomies
				WHERE collection = ${input.collection}
					AND entry_id = ${anchorGroup}
					AND taxonomy_id IN (
						SELECT DISTINCT translation_group FROM taxonomies
						WHERE name IN (${sql.join(
							carriedList.map((t) => sql`${t}`),
							sql`, `,
						)})
							AND translation_group IS NOT NULL
					)
					AND EXISTS (SELECT 1 FROM ${sql.ref(tableName)} WHERE id = ${entryId} AND deleted_at IS NULL)
			`);
		}
		const termsToInsert = expectedBaseline
			? input.terms.filter((t) => carriedSet.has(t.taxonomy))
			: input.terms;
		const uniqueTermGroups = [...new Set(termsToInsert.map((t) => t.termGroup))];
		for (let i = 0; i < uniqueTermGroups.length; i += TAXONOMY_PIVOT_CHUNK_SIZE) {
			const chunk = uniqueTermGroups.slice(i, i + TAXONOMY_PIVOT_CHUNK_SIZE);
			const tuples = chunk.map(
				(termGroup) => sql`(${input.collection}, ${effectiveGroup}, ${termGroup})`,
			);
			queries.push(
				isPg
					? sql`
						INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
						VALUES ${sql.join(tuples, sql`, `)}
						ON CONFLICT (collection, entry_id, taxonomy_id) DO NOTHING
					`
					: sql`
						INSERT OR IGNORE INTO content_taxonomies (collection, entry_id, taxonomy_id)
						VALUES ${sql.join(tuples, sql`, `)}
					`,
			);
		}

		// Mutable translation-group CAS baseline
		if (expectedBaseline && anchorGroup) {
			queries.push(sql`
				UPDATE _emdash_wxr_group_baselines
				SET generation = ${expectedBaseline.generation + 1},
					terms_json = ${nextTermsJson},
					last_operation_id = ${operationId},
					updated_at = ${now}
				WHERE collection = ${input.collection}
					AND translation_group = ${anchorGroup}
					AND source_lineage = ${input.sourceLineage}
					AND generation = ${expectedBaseline.generation}
					AND EXISTS (SELECT 1 FROM ${sql.ref(tableName)} WHERE id = ${entryId} AND deleted_at IS NULL)
			`);
		} else {
			const anchorSeoJson = wroteUnprotectedSeo ? serializeSeoSnapshot(input.seo, now) : null;
			const anchorBylinesKey = canonicalBylinesKey(resolvedBylines.credits);
			queries.push(sql`
				INSERT INTO _emdash_wxr_group_baselines
					(collection, translation_group, source_lineage, source_group_id, anchor_entry_id,
					anchor_updated_at, anchor_seo_json, anchor_bylines_json, generation,
					anchor_state_hash, terms_json, last_operation_id, updated_at)
				SELECT ${input.collection}, ${effectiveGroup}, ${input.sourceLineage},
					${input.sourceGroupId ?? null}, ${entryId}, ${now},
					${anchorSeoJson}, ${anchorBylinesKey}, 1,
					${committedHash}, ${nextTermsJson}, ${operationId}, ${now}
				WHERE EXISTS (SELECT 1 FROM ${sql.ref(tableName)} WHERE id = ${entryId} AND deleted_at IS NULL)
			`);
		}

		// Immutable create receipt
		queries.push(sql`
			INSERT INTO _emdash_wxr_import_receipts
				(operation_id, source_lineage, source_post_id, collection, entry_id, slug, locale,
				translation_group, status, input_fingerprint, stored_data_hash, committed_hash,
				has_seo, has_protected, protected_seo_json, receipt_state, created_at)
			SELECT ${operationId}, ${input.sourceLineage}, ${input.sourcePostId}, ${input.collection},
				${entryId}, ${input.slug}, ${input.locale}, ${effectiveGroup}, ${input.status},
				${input.inputFingerprint}, ${storedDataHash}, ${committedHash},
				${wroteUnprotectedSeo ? 1 : 0}, ${input.protection ? 1 : 0}, ${protectedSeoJson},
				'finished', ${now}
			WHERE EXISTS (SELECT 1 FROM ${sql.ref(tableName)} WHERE id = ${entryId} AND deleted_at IS NULL)
		`);

		// Final integrity predicate: verifies content, receipt, baseline, AND that every
		// written taxonomy pivot and byline credit still references a live target.
		const expectedGeneration = expectedBaseline ? expectedBaseline.generation + 1 : 1;
		const integrityPredicate = input._forceAssertionFailure
			? sql<boolean>`1 = 0`
			: sql<boolean>`
				EXISTS (SELECT 1 FROM ${sql.ref(tableName)} WHERE id = ${entryId} AND deleted_at IS NULL)
				AND EXISTS (
					SELECT 1 FROM _emdash_wxr_import_receipts
					WHERE operation_id = ${operationId}
						AND entry_id = ${entryId}
						AND receipt_state = 'finished'
				)
				AND EXISTS (
					SELECT 1 FROM _emdash_wxr_group_baselines
					WHERE collection = ${input.collection}
						AND translation_group = ${effectiveGroup}
						AND generation = ${expectedGeneration}
						AND last_operation_id = ${operationId}
				)
				AND NOT EXISTS (
					SELECT 1 FROM content_taxonomies AS ct
					WHERE ct.collection = ${input.collection}
						AND ct.entry_id = ${effectiveGroup}
						AND NOT EXISTS (
							SELECT 1 FROM taxonomies AS t
							WHERE t.translation_group = ct.taxonomy_id
						)
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_content_bylines AS cb
					WHERE cb.collection_slug = ${input.collection}
						AND cb.content_id = ${entryId}
						AND NOT EXISTS (
							SELECT 1 FROM _emdash_bylines AS b
							WHERE b.translation_group = cb.byline_id
						)
				)
			`;

		// On D1 `.batch()` (SQLite), append a SQLite-native rollback assertion statement.
		// On real SQLite/Postgres transactions, check the predicate inside the transaction
		// and throw to ROLLBACK cleanly without constant-folded `1 / 0` in Postgres.
		const batchRollbackAssertion = sql`SELECT CASE WHEN (${integrityPredicate}) THEN 1 ELSE json('incomplete atomic wxr import') END AS ok`;
		const trxIntegrityCheck = sql<{
			ok: number;
		}>`SELECT CASE WHEN (${integrityPredicate}) THEN 1 ELSE 0 END AS ok`;

		// 9. Enforce D1 statement limits BEFORE sending (reject oversize with no fallback write).
		const limitError = validateCompiledD1Limits(this.db, [...queries, batchRollbackAssertion]);
		if (limitError) {
			return { outcome: "error", code: "D1_LIMIT_EXCEEDED", message: limitError };
		}

		// 10. Execute atomically: D1 `.batch()` OR real DB transaction.
		try {
			if (input._beforeCommit) {
				await input._beforeCommit();
			}
			const batched = await executeAtomicBatchIfSupported(this.db, [
				...queries,
				batchRollbackAssertion,
			]);
			if (!batched) {
				await this.db.transaction().execute(async (trx) => {
					for (const query of queries) {
						// oxlint-disable-next-line no-await-in-loop -- statements execute sequentially in one transaction
						await query.execute(trx);
					}
					const check = await trxIntegrityCheck.execute(trx);
					if (Number(check.rows[0]?.ok) !== 1) {
						throw new Error("incomplete atomic wxr import");
					}
				});
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("transactions are not supported")) {
				return {
					outcome: "error",
					code: "ATOMIC_BATCH_UNSUPPORTED",
					message: "Database adapter supports neither atomic D1 batch nor real transactions",
				};
			}
			// Re-check if a concurrent replay won the race on the same source key.
			const racedReceipt = await this.findReceipt(
				input.sourceLineage,
				input.sourcePostId,
				input.locale,
			);
			if (racedReceipt) {
				return classifyExistingReceipt(
					racedReceipt,
					input.collection,
					input.inputFingerprint,
					input.sourcePostId,
					input.locale,
				);
			}
			if (msg.includes("incomplete atomic wxr import") || msg.includes("malformed JSON")) {
				return {
					outcome: "conflict",
					reason: expectedBaseline
						? `Translation group "${anchorGroup}" changed concurrently or was edited outside the import`
						: `Atomic import integrity check failed for "${input.slug}"`,
				};
			}
			return { outcome: "error", code: "ATOMIC_WXR_IMPORT_ERROR", message: msg };
		}

		// Post-commit derived cache invalidations (coalesced when inside coalesceObjectCacheWrites).
		invalidateCollectionCache(input.collection);
		if (uniqueTermGroups.length > 0) invalidateTermCache();
		if (resolvedBylines.statements.length > 0) invalidateBylineObjectCache();

		return {
			outcome: "created",
			receipt: {
				collection: input.collection,
				id: entryId,
				slug: input.slug,
				locale: input.locale,
				translationGroup: effectiveGroup,
				status: input.status,
				operationId,
				sourcePostId: input.sourcePostId,
				storedDataHash,
				committedHash,
				outcome: "created",
			},
		};
	}
}
