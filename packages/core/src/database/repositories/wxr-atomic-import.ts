/**
 * Atomic per-post WXR import repository (Item 132).
 *
 * Commits a single WXR post's missing taxonomy terms, missing guest byline,
 * content row, protection, bylines, SEO, taxonomy pivots, approved comments,
 * mutable translation-group CAS baseline, and immutable create receipt in ONE
 * atomic D1 `.batch()` (or SQLite serialized transaction), refusing adapters
 * that do not provide this atomic guarantee (including PostgreSQL READ COMMITTED).
 */

import { SqliteAdapter, sql, type Kysely, type RawBuilder } from "kysely";
import { ulid } from "ulidx";

import type { ContentProtection } from "../../content/protection.js";
import type { PreparedAtomicComment } from "../../import/comments.js";
import {
	invalidateBylineObjectCache,
	invalidateCollectionCache,
	invalidateCommentObjectCache,
	invalidateTaxonomyObjectCache,
} from "../../object-cache/index.js";
import { invalidateTermCache } from "../../taxonomies/index.js";
import { executeAtomicBatchIfSupported } from "../dialect-helpers.js";
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
/** 9 bound columns per taxonomies row -> max 10 rows (90 <= 100 D1 bind limit). */
const PENDING_TERM_CHUNK_SIZE = 10;
/** 10 bound columns per _emdash_comments row -> max 9 rows (90 <= 100 D1 bind limit). */
const COMMENT_CHUNK_SIZE = 9;

export interface AtomicWxrSectionCreateInput {
	sourceLineage: string;
	/** Typed section key, e.g. `section:<wp_post_id>` or `section:missing:<idx>:<slug>`. */
	sourcePostId: string;
	slug: string;
	locale: string;
	title: string;
	/** Serialized Portable Text JSON written into `_emdash_sections.content`. */
	contentJson: string;
	/** Opaque SHA-256 fingerprint of stable source section inputs (slug, title, rawContent). */
	inputFingerprint: string;
	/** Test-only hook to force the final SQL integrity assertion to fail and roll back. */
	_forceAssertionFailure?: boolean;
	/** Test-only hook invoked right before executing the atomic batch/transaction. */
	_beforeCommit?: () => Promise<void>;
}

export interface WxrTermPivot {
	taxonomy: string;
	termGroup: string;
}

export interface PendingAtomicTerm {
	id: string;
	name: string;
	slug: string;
	label: string;
	description?: string;
	locale: string;
	translationGroup: string;
}

export interface PendingGuestByline {
	slug: string;
	displayName: string;
	userId?: string | null;
	locale?: string;
}

export interface AtomicWxrCreateInput {
	sourceLineage: string;
	sourcePostId: string;
	/** Source-side translation group ID (e.g. WPML/Polylang trid). REQUIRED when translationOf is set. */
	sourceGroupId?: string;
	collection: string;
	slug: string;
	locale: string;
	status: "draft" | "published" | "scheduled";
	data: Record<string, unknown>;
	authorId?: string;
	bylines?: ContentBylineInput[];
	/** Guest byline to insert INSIDE the atomic batch if not already present (zero writes on skip/conflict). */
	pendingGuestByline?: PendingGuestByline;
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
	/** Missing taxonomy term/mirror rows to insert INSIDE the atomic batch. */
	pendingTerms?: readonly PendingAtomicTerm[];
	/** Carried taxonomy names whose pivots should be replaced on translation creates. */
	replaceTaxonomies?: readonly string[];
	/** Approved comments for this post to insert INSIDE the atomic batch. */
	pendingComments?: readonly PreparedAtomicComment[];
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
	/** Created guest byline ID when `pendingGuestByline` was committed in this batch. */
	createdBylineId?: string;
	outcome: "created" | "replayed" | "changed";
}

export type AtomicWxrApplyResult =
	| { outcome: "created"; receipt: AtomicWxrItemReceipt }
	| { outcome: "replayed"; receipt: AtomicWxrItemReceipt }
	| { outcome: "changed"; receipt: AtomicWxrItemReceipt; reason: string }
	| { outcome: "skipped"; reason: string; existingId: string }
	| { outcome: "conflict"; reason: string }
	| { outcome: "error"; code: string; message: string };

interface BylineCreditSpec {
	group: string;
	roleLabel: string | null;
	sortOrder: number;
}

const utf8Encoder = new TextEncoder();

/**
 * Returns true iff `db` supports atomic D1 `.batch()` or a serialized SQLite
 * transaction. PostgreSQL is refused until a dedicated two-session concurrency
 * proof validates its isolation level against concurrent group writers.
 */
export function supportsAtomicWxrImport(db: Kysely<Database>): boolean {
	const adapter = db.getExecutor().adapter;
	if ("executeAtomicBatch" in adapter && typeof adapter.executeAtomicBatch === "function") {
		return true;
	}
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

/** Sorted CSV of distinct taxonomy_id values matching SQLite BINARY ORDER BY. */
function canonicalTermGroupCsv(terms: readonly WxrTermPivot[]): string {
	const groups = [...new Set(terms.map((t) => t.termGroup))].toSorted((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	return groups.join(",");
}

/** Separator-safe canonical string matching SQLite's `char(31)` / `char(30)` / `char(29)` NULL sentinel. */
function canonicalBylinesGuardString(credits: readonly BylineCreditSpec[]): string {
	return credits
		.map(
			(c) => `${c.sortOrder}\u001f${c.group}\u001f${c.roleLabel === null ? "\u001d" : c.roleLabel}`,
		)
		.join("\u001e");
}

function parseAnchorBylinesJson(raw: string): BylineCreditSpec[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: BylineCreditSpec[] = [];
		for (const item of parsed) {
			if (
				typeof item === "object" &&
				item !== null &&
				"group" in item &&
				typeof item.group === "string" &&
				"sortOrder" in item &&
				typeof item.sortOrder === "number"
			) {
				const roleLabel =
					"roleLabel" in item && typeof item.roleLabel === "string" ? item.roleLabel : null;
				out.push({ group: item.group, roleLabel, sortOrder: item.sortOrder });
			}
		}
		return out;
	} catch {
		return [];
	}
}

interface BaselineSeoSnapshot {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: number;
	updatedAt: string;
}

function serializeSeoSnapshot(seo: ContentSeoInput | undefined, updatedAt: string): string | null {
	if (!seo) return null;
	const snapshot: BaselineSeoSnapshot = {
		title: seo.title ?? null,
		description: seo.description ?? null,
		image: seo.image ?? null,
		canonical: seo.canonical ?? null,
		noIndex: seo.noIndex ? 1 : 0,
		updatedAt,
	};
	return JSON.stringify(snapshot);
}

function isNullableString(v: unknown): v is string | null {
	return v === null || typeof v === "string";
}

function parseSeoSnapshot(raw: string | null): BaselineSeoSnapshot | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (
			"title" in parsed &&
			isNullableString(parsed.title) &&
			"description" in parsed &&
			isNullableString(parsed.description) &&
			"image" in parsed &&
			isNullableString(parsed.image) &&
			"canonical" in parsed &&
			isNullableString(parsed.canonical) &&
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

function serializeExpectedSqlValue(value: unknown): string | number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return value;
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

/**
 * Typed, null-safe SQLite predicate asserting `translation_source.<field>` matches the
 * exact serialized value that the batch copies and hashes (distinguishes NULL vs "" vs 0 vs "0").
 */
function buildTypedInheritedFieldGuard(field: string, value: unknown): RawBuilder<boolean> {
	const col = sql.ref(`translation_source.${field}`);
	const serialized = serializeExpectedSqlValue(value);
	if (serialized === null) {
		return sql<boolean>`${col} IS NULL`;
	}
	if (typeof serialized === "number") {
		return sql<boolean>`typeof(${col}) IN ('integer', 'real') AND ${col} = ${serialized}`;
	}
	return sql<boolean>`typeof(${col}) = 'text' AND ${col} = ${serialized}`;
}

/** Canonical, ULID-free representation of committed comments (preserves threading via parentIndex). */
export function canonicalCommentsPlan(comments: readonly PreparedAtomicComment[]): Array<{
	parentIndex: number | null;
	authorName: string;
	authorEmail: string;
	body: string;
	status: string;
	createdAt: string;
}> {
	const indexById = new Map<string, number>();
	for (const [idx, c] of comments.entries()) {
		indexById.set(c.id, idx);
	}
	return comments.map((c) => ({
		parentIndex: c.parentId !== null ? (indexById.get(c.parentId) ?? null) : null,
		authorName: c.authorName,
		authorEmail: c.authorEmail,
		body: c.body,
		status: c.status,
		createdAt: c.createdAt,
	}));
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
	 * Execute ONE atomic per-post create (missing terms + missing guest byline +
	 * content row + protection + bylines + SEO + taxonomy pivots + approved
	 * comments + mutable group baseline + immutable receipt).
	 */
	async applyCreate(input: AtomicWxrCreateInput): Promise<AtomicWxrApplyResult> {
		validateIdentifier(input.collection, "collection slug");
		if (!supportsAtomicWxrImport(this.db)) {
			return {
				outcome: "error",
				code: "ATOMIC_BATCH_UNSUPPORTED",
				message: "Database adapter does not support atomic WXR import batches",
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

		// 3. For translations, load & validate the mutable group CAS baseline + require sourceGroupId.
		let anchorGroup: string | undefined;
		let expectedBaseline: WxrGroupBaselineTable | undefined;
		let baselineTerms: WxrTermPivot[] = [];
		let baselineBylines: BylineCreditSpec[] = [];
		let anchorRow: Awaited<ReturnType<ContentRepository["findById"]>> = null;
		if (input.translationOf) {
			if (!input.sourceGroupId) {
				return {
					outcome: "conflict",
					reason: "Translation create requires an explicit sourceGroupId",
				};
			}
			anchorRow = await contentRepo.findById(input.collection, input.translationOf);
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
				!expectedBaseline.source_group_id ||
				expectedBaseline.source_group_id !== input.sourceGroupId
			) {
				return {
					outcome: "conflict",
					reason: `Translation group "${anchorGroup}" belongs to source group "${expectedBaseline.source_group_id ?? ""}", not "${input.sourceGroupId}"`,
				};
			}
			baselineTerms = parseTermsJson(expectedBaseline.terms_json);
			baselineBylines = parseAnchorBylinesJson(expectedBaseline.anchor_bylines_json);
		}

		// 4. Resolve bylines up front via shared BylineRepository preparation (chunked <= 98 binds/stmt).
		// When inheriting anchor bylines, build directly from `expectedBaseline.anchor_bylines_json`
		// (the exact state verified by the SQL guard) rather than a separate unguarded preread.
		const now = new Date().toISOString();
		const entryId = ulid();
		const operationId = ulid();
		const bylineRepo = new BylineRepository(this.db);
		let createdGuestBylineId: string | undefined;
		let pendingGuestBylineStmt: RawBuilder<unknown> | undefined;
		let resolvedBylines: {
			primaryBylineId: string | null;
			credits: BylineCreditSpec[];
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
		} else if (input.pendingGuestByline) {
			const g = input.pendingGuestByline;
			const guestId = ulid();
			const guestLocale = g.locale ?? "en";
			createdGuestBylineId = guestId;
			pendingGuestBylineStmt = sql`
				INSERT INTO _emdash_bylines
					(id, slug, display_name, bio, avatar_media_id, website_url, user_id, is_guest, created_at, updated_at, locale, translation_group)
				VALUES (${guestId}, ${g.slug}, ${g.displayName}, NULL, NULL, NULL, ${g.userId ?? null}, ${g.userId ? 0 : 1}, ${now}, ${now}, ${guestLocale}, ${guestId})
			`;
			resolvedBylines = bylineRepo.buildContentBylineInserts(
				input.collection,
				entryId,
				[{ group: guestId, roleLabel: null, sortOrder: 0 }],
				now,
			);
		} else if (input.translationOf) {
			resolvedBylines = bylineRepo.buildContentBylineInserts(
				input.collection,
				entryId,
				baselineBylines,
				now,
			);
		}

		// 5. Merge anchor's inherited fields into effectiveData BEFORE prepareCreate so
		// `storedDataHash` hashes the exact inherited projection that the batch compares and writes.
		const effectiveData: Record<string, unknown> = { ...input.data };
		const inheritedChecks: RawBuilder<boolean>[] = [];
		if (input.translationOf && anchorRow && !input.protection && input.inheritFields?.length) {
			for (const field of input.inheritFields) {
				validateIdentifier(field, "inherited content field name");
				if (Object.hasOwn(anchorRow.data, field)) {
					effectiveData[field] = anchorRow.data[field];
				} else {
					delete effectiveData[field];
				}
				inheritedChecks.push(buildTypedInheritedFieldGuard(field, effectiveData[field]));
			}
		}

		// 6. Build DB-side group state guard for translation writes (checked IN the batch).
		const effectiveGroup = anchorGroup ?? entryId;
		let groupGuardPredicate: RawBuilder<boolean> | undefined;
		if (expectedBaseline && anchorGroup && input.sourceGroupId) {
			const expectedTermsCsv = canonicalTermGroupCsv(baselineTerms);
			const liveTermsCsvExpr = sql`COALESCE((SELECT group_concat(taxonomy_id, ',') FROM (SELECT ct.taxonomy_id AS taxonomy_id FROM content_taxonomies AS ct WHERE ct.collection = ${input.collection} AND ct.entry_id = ${anchorGroup} ORDER BY ct.taxonomy_id ASC)), '')`;

			const expectedBylinesGuard = canonicalBylinesGuardString(baselineBylines);
			const liveAnchorBylinesExpr = sql`COALESCE((SELECT group_concat(item, char(30)) FROM (SELECT CAST(cb.sort_order AS TEXT) || char(31) || cb.byline_id || char(31) || CASE WHEN cb.role_label IS NULL THEN char(29) ELSE cb.role_label END AS item FROM _emdash_content_bylines AS cb WHERE cb.collection_slug = ${input.collection} AND cb.content_id = ${expectedBaseline.anchor_entry_id} ORDER BY cb.sort_order ASC)), '')`;

			const anchorSeoSnap = parseSeoSnapshot(expectedBaseline.anchor_seo_json);
			const anchorSeoPredicate = anchorSeoSnap
				? sql<boolean>`EXISTS (
					SELECT 1 FROM _emdash_seo AS s
					WHERE s.collection = ${input.collection}
						AND s.content_id = ${expectedBaseline.anchor_entry_id}
						AND s.seo_title IS ${anchorSeoSnap.title}
						AND s.seo_description IS ${anchorSeoSnap.description}
						AND s.seo_image IS ${anchorSeoSnap.image}
						AND s.seo_canonical IS ${anchorSeoSnap.canonical}
						AND s.seo_no_index = ${anchorSeoSnap.noIndex}
						AND s.updated_at = ${anchorSeoSnap.updatedAt}
				)`
				: sql<boolean>`NOT EXISTS (
					SELECT 1 FROM _emdash_seo AS s
					WHERE s.collection = ${input.collection}
						AND s.content_id = ${expectedBaseline.anchor_entry_id}
				)`;

			const inheritedPredicate =
				inheritedChecks.length > 0
					? sql<boolean>`AND ${sql.join(inheritedChecks, sql` AND `)}`
					: sql<boolean>``;

			// Guard checks IN the batch:
			//  1. Mutable group baseline generation + lineage + unconditional source_group_id match
			//  2. Anchor row is unedited (version = 1, updated_at matches baseline, inherited columns match hashed values)
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
						AND gb.source_group_id = ${input.sourceGroupId}
						AND gb.generation = ${expectedBaseline.generation}
				)
				AND translation_source.version = 1
				AND translation_source.updated_at = ${expectedBaseline.anchor_updated_at}
				${inheritedPredicate}
				AND ${liveTermsCsvExpr} = ${expectedTermsCsv}
				AND ${liveAnchorBylinesExpr} = ${expectedBylinesGuard}
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
								AND pc.seo IS r.protected_seo_json
						)
				)
			`;
		}

		// 7. Prepare content INSERT (+ protection + visibility bump) via shared ContentRepository.prepareCreate.
		const protectedSeoInput = input.protection && input.hasSeo ? (input.seo ?? null) : null;
		const preparedContent = await contentRepo.prepareCreate({
			id: entryId,
			now,
			type: input.collection,
			slug: input.slug,
			data: effectiveData,
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

		// 8. Compute post-normalization & post-inheritance storedDataHash + next group terms + committedHash.
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
				publishedAt: input.publishedAt ?? null,
				scheduledAt: input.scheduledAt ?? null,
				storedDataHash,
				primaryBylineId: resolvedBylines.primaryBylineId,
				seo: input.hasSeo ? (input.seo ?? null) : null,
				terms: nextTermsJson,
				comments: canonicalCommentsPlan(input.pendingComments ?? []),
			}),
		);

		// 9. Assemble ALL writes into ONE bounded atomic batch (zero writes outside this batch).
		const queries: RawBuilder<unknown>[] = [];

		// Missing taxonomy term / mirror rows created atomically inside this batch (plain INSERT,
		// chunked <= 90 binds/stmt; any concurrent UNIQUE race rolls back cleanly with 0 writes).
		const pendingTerms = input.pendingTerms ?? [];
		for (let i = 0; i < pendingTerms.length; i += PENDING_TERM_CHUNK_SIZE) {
			const chunk = pendingTerms.slice(i, i + PENDING_TERM_CHUNK_SIZE);
			const tuples = chunk.map(
				(term) =>
					sql`(${term.id}, ${term.name}, ${term.slug}, ${term.label}, NULL, ${term.description ? JSON.stringify({ description: term.description }) : null}, 0, ${term.locale}, ${term.translationGroup})`,
			);
			queries.push(sql`
				INSERT INTO taxonomies
					(id, name, slug, label, parent_id, data, sort_order, locale, translation_group)
				VALUES ${sql.join(tuples, sql`, `)}
			`);
		}

		// Missing guest byline created atomically inside this batch.
		if (pendingGuestBylineStmt) {
			queries.push(pendingGuestBylineStmt);
		}

		// Content row (+ protection + visibility bump)
		queries.push(...preparedContent.queries);

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
			queries.push(sql`
				INSERT OR IGNORE INTO content_taxonomies (collection, entry_id, taxonomy_id)
				VALUES ${sql.join(tuples, sql`, `)}
			`);
		}

		// Approved comments for this post committed atomically inside this batch (chunked <= 90 binds/stmt).
		const pendingComments = input.pendingComments ?? [];
		for (let i = 0; i < pendingComments.length; i += COMMENT_CHUNK_SIZE) {
			const chunk = pendingComments.slice(i, i + COMMENT_CHUNK_SIZE);
			const tuples = chunk.map(
				(c) =>
					sql`(${c.id}, ${input.collection}, ${entryId}, ${c.parentId}, ${c.authorName}, ${c.authorEmail}, NULL, ${c.body}, ${c.status}, NULL, NULL, NULL, ${c.createdAt}, ${c.createdAt})`,
			);
			queries.push(sql`
				INSERT INTO _emdash_comments
					(id, collection, content_id, parent_id, author_name, author_email, author_user_id, body, status, ip_hash, user_agent, moderation_metadata, created_at, updated_at)
				VALUES ${sql.join(tuples, sql`, `)}
			`);
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
			const anchorBylinesJson = JSON.stringify(resolvedBylines.credits);
			queries.push(sql`
				INSERT INTO _emdash_wxr_group_baselines
					(collection, translation_group, source_lineage, source_group_id, anchor_entry_id,
					anchor_updated_at, anchor_seo_json, anchor_bylines_json, generation,
					anchor_state_hash, terms_json, last_operation_id, updated_at)
				SELECT ${input.collection}, ${effectiveGroup}, ${input.sourceLineage},
					${input.sourceGroupId ?? null}, ${entryId}, ${now},
					${anchorSeoJson}, ${anchorBylinesJson}, 1,
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
		// written taxonomy pivot and byline credit references a live target.
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

		const batchRollbackAssertion = sql`SELECT CASE WHEN (${integrityPredicate}) THEN 1 ELSE json('incomplete atomic wxr import') END AS ok`;
		const trxIntegrityCheck = sql<{
			ok: number;
		}>`SELECT CASE WHEN (${integrityPredicate}) THEN 1 ELSE 0 END AS ok`;

		// 10. Enforce D1 statement limits BEFORE sending (reject oversize with no fallback write).
		const limitError = validateCompiledD1Limits(this.db, [...queries, batchRollbackAssertion]);
		if (limitError) {
			return { outcome: "error", code: "D1_LIMIT_EXCEEDED", message: limitError };
		}

		// 11. Execute atomically: D1 `.batch()` OR serialized SQLite transaction.
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
					message: "Database adapter does not support atomic WXR import batches",
				};
			}
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
			const racedSlug = await contentRepo.findBySlug(input.collection, input.slug, input.locale);
			if (racedSlug) {
				return {
					outcome: "skipped",
					reason: `Slug "${input.slug}" (${input.locale}) already exists without a matching import receipt`,
					existingId: racedSlug.id,
				};
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
		if (uniqueTermGroups.length > 0 || pendingTerms.length > 0) {
			invalidateTermCache();
			if (pendingTerms.length > 0) invalidateTaxonomyObjectCache();
		}
		if (resolvedBylines.statements.length > 0 || pendingGuestBylineStmt) {
			invalidateBylineObjectCache();
		}
		if (pendingComments.length > 0) {
			invalidateCommentObjectCache();
		}

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
				createdBylineId: createdGuestBylineId,
				outcome: "created",
			},
		};
	}

	/**
	 * Execute ONE atomic per-section (`wp_block`) create with its own immutable
	 * producer receipt in `_emdash_wxr_import_receipts` (`collection = "_emdash_sections"`).
	 * Concurrent receipt/slug losers re-read and classify after rollback.
	 */
	async applySectionCreate(input: AtomicWxrSectionCreateInput): Promise<AtomicWxrApplyResult> {
		const collection = "_emdash_sections";
		if (!supportsAtomicWxrImport(this.db)) {
			return {
				outcome: "error",
				code: "ATOMIC_BATCH_UNSUPPORTED",
				message: "Database adapter does not support atomic WXR import batches",
			};
		}

		// 1. Read-only receipt check (ZERO writes).
		const existingReceipt = await this.findReceipt(
			input.sourceLineage,
			input.sourcePostId,
			input.locale,
		);
		if (existingReceipt) {
			return classifyExistingReceipt(
				existingReceipt,
				collection,
				input.inputFingerprint,
				input.sourcePostId,
				input.locale,
			);
		}

		// 2. Read-only slug check against `_emdash_sections` (ZERO writes).
		const findSectionBySlug = () =>
			this.db
				.selectFrom("_emdash_sections")
				.select("id")
				.where("slug", "=", input.slug)
				.executeTakeFirst();
		const existingSection = await findSectionBySlug();
		if (existingSection) {
			const racedReceipt = await this.findReceipt(
				input.sourceLineage,
				input.sourcePostId,
				input.locale,
			);
			if (racedReceipt) {
				return classifyExistingReceipt(
					racedReceipt,
					collection,
					input.inputFingerprint,
					input.sourcePostId,
					input.locale,
				);
			}
			return {
				outcome: "skipped",
				reason: `Section slug "${input.slug}" already exists without a matching import receipt`,
				existingId: existingSection.id,
			};
		}

		// 3. Plan ONE atomic batch/tx: `_emdash_sections` + `_emdash_wxr_import_receipts` + integrity check.
		const now = new Date().toISOString();
		const sectionId = ulid();
		const operationId = ulid();
		const storedDataHash = await computeStoredDataHash({
			slug: input.slug,
			title: input.title,
			content: input.contentJson,
		});
		const committedHash = await sha256Hex(
			canonicalJson({
				collection,
				slug: input.slug,
				locale: input.locale,
				storedDataHash,
			}),
		);

		const queries: RawBuilder<unknown>[] = [
			sql`
				INSERT INTO _emdash_sections
					(id, slug, title, description, keywords, content, preview_media_id, source, theme_id, created_at, updated_at)
				VALUES (
					${sectionId}, ${input.slug}, ${input.title}, NULL, NULL,
					${input.contentJson}, NULL, 'import', NULL, ${now}, ${now}
				)
			`,
			sql`
				INSERT INTO _emdash_wxr_import_receipts
					(operation_id, source_lineage, source_post_id, collection, entry_id, slug, locale,
					translation_group, status, input_fingerprint, stored_data_hash, committed_hash,
					has_seo, has_protected, protected_seo_json, receipt_state, created_at)
				SELECT ${operationId}, ${input.sourceLineage}, ${input.sourcePostId}, ${collection},
					${sectionId}, ${input.slug}, ${input.locale}, ${sectionId}, 'published',
					${input.inputFingerprint}, ${storedDataHash}, ${committedHash},
					0, 0, NULL, 'finished', ${now}
				WHERE EXISTS (SELECT 1 FROM _emdash_sections WHERE id = ${sectionId})
			`,
		];

		const integrityPredicate = input._forceAssertionFailure
			? sql<boolean>`1 = 0`
			: sql<boolean>`
				EXISTS (SELECT 1 FROM _emdash_sections WHERE id = ${sectionId})
				AND EXISTS (
					SELECT 1 FROM _emdash_wxr_import_receipts
					WHERE operation_id = ${operationId}
						AND entry_id = ${sectionId}
						AND receipt_state = 'finished'
				)
			`;
		const batchRollbackAssertion = sql`SELECT CASE WHEN (${integrityPredicate}) THEN 1 ELSE json('incomplete atomic wxr section import') END AS ok`;
		const trxIntegrityCheck = sql<{
			ok: number;
		}>`SELECT CASE WHEN (${integrityPredicate}) THEN 1 ELSE 0 END AS ok`;

		const limitError = validateCompiledD1Limits(this.db, [...queries, batchRollbackAssertion]);
		if (limitError) {
			return { outcome: "error", code: "D1_LIMIT_EXCEEDED", message: limitError };
		}

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
						throw new Error("incomplete atomic wxr section import");
					}
				});
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("transactions are not supported")) {
				return {
					outcome: "error",
					code: "ATOMIC_BATCH_UNSUPPORTED",
					message: "Database adapter does not support atomic WXR import batches",
				};
			}
			// Concurrent receipt/slug losers re-read and classify after rollback.
			const racedReceipt = await this.findReceipt(
				input.sourceLineage,
				input.sourcePostId,
				input.locale,
			);
			if (racedReceipt) {
				return classifyExistingReceipt(
					racedReceipt,
					collection,
					input.inputFingerprint,
					input.sourcePostId,
					input.locale,
				);
			}
			const racedSection = await findSectionBySlug();
			if (racedSection) {
				return {
					outcome: "skipped",
					reason: `Section slug "${input.slug}" already exists without a matching import receipt`,
					existingId: racedSection.id,
				};
			}
			if (msg.includes("incomplete atomic wxr section import") || msg.includes("malformed JSON")) {
				return {
					outcome: "conflict",
					reason: `Atomic section import integrity check failed for "${input.slug}"`,
				};
			}
			return { outcome: "error", code: "ATOMIC_WXR_IMPORT_ERROR", message: msg };
		}

		invalidateCollectionCache(collection);
		return {
			outcome: "created",
			receipt: {
				collection,
				id: sectionId,
				slug: input.slug,
				locale: input.locale,
				translationGroup: sectionId,
				status: "published",
				operationId,
				sourcePostId: input.sourcePostId,
				storedDataHash,
				committedHash,
				outcome: "created",
			},
		};
	}
}
