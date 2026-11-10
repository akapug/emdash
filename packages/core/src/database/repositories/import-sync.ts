import { SqliteAdapter, sql, type Kysely, type QueryResult } from "kysely";
import { ulid } from "ulidx";

import { invalidateCollectionCache } from "../../object-cache/index.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { executeAtomicBatchIfSupported } from "../dialect-helpers.js";
import {
	hasImportBaselineTriggers,
	importBaselineTriggerWitness,
} from "../import-baseline-triggers.js";
import type { Database } from "../types.js";
import { validateIdentifier } from "../validate.js";
import { createRevisionId } from "./revision.js";

export interface ImportSyncSource {
	site: string;
	type: "page" | "post";
	id: string;
}

export interface ImportSyncInput {
	operationId: string;
	source: ImportSyncSource;
	collection: string;
	locale: string;
	sequence: number;
	requestHash: string;
	grant: { id: string; bindingId: string; generation: number };
	mappedFields: string[];
	entryId?: string;
	expectedVersion?: number;
	slug: string;
	data: Record<string, unknown>;
	authorId: string;
	createdAt?: string;
	publishedAt?: string;
}

export type ImportSyncRequestIdentity = Pick<
	ImportSyncInput,
	"source" | "collection" | "locale" | "sequence" | "requestHash" | "entryId" | "grant"
>;

export interface ImportSyncApplied {
	state: "applied";
	entryId: string;
	revisionId: string;
	originalRevisionId: string;
	version: number;
	replayed: boolean;
}

export type ImportSyncResult =
	| ImportSyncApplied
	| { state: "conflict" | "unknown"; reason: string };

interface OperationRow {
	operation_id: string;
	source_site: string;
	source_type: string;
	source_id: string;
	collection: string;
	entry_id: string;
	locale: string;
	sequence: number;
	request_hash: string;
	revision_id: string;
	version: number;
	completed: number;
	grant_id?: string | null;
	grant_generation?: number | null;
	binding_id?: string | null;
	original_revision_id: string | null;
}

const SYSTEM_COLUMNS = new Set([
	"id",
	"slug",
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"locale",
	"translation_group",
]);

/** Unknown adapters must not inherit detectDialect's SQLite default. */
export function supportsAtomicImportSync(db: Kysely<Database>): boolean {
	const adapter = db.getExecutor().adapter;
	if (!(adapter instanceof SqliteAdapter)) return false;
	return (
		adapter.constructor === SqliteAdapter ||
		("executeAtomicBatch" in adapter && typeof adapter.executeAtomicBatch === "function")
	);
}

function storedValue(value: unknown): unknown {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}

function applied(row: OperationRow, replayed: boolean): ImportSyncApplied {
	if (row.completed !== 1 || !row.original_revision_id) {
		throw new Error("Import operation has no complete durable result");
	}
	return {
		state: "applied",
		entryId: row.entry_id,
		revisionId: row.revision_id,
		originalRevisionId: row.original_revision_id,
		version: row.version,
		replayed,
	};
}

export class ImportSyncRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async supports(collection?: string): Promise<boolean> {
		if (!supportsAtomicImportSync(this.db)) return false;
		try {
			const [grants, operations] = await Promise.all([
				sql<{ name: string }>`PRAGMA table_info(_emdash_import_grants)`.execute(this.db),
				sql<{ name: string }>`PRAGMA table_info(_emdash_import_operations)`.execute(this.db),
			]);
			const grantColumns = new Set(grants.rows.map((column) => column.name));
			const operationColumns = new Set(operations.rows.map((column) => column.name));
			if (
				!["id", "source_site", "binding_id", "actor_id", "generation", "revoked"].every((column) =>
					grantColumns.has(column),
				) ||
				!["grant_id", "grant_generation", "binding_id"].every((column) =>
					operationColumns.has(column),
				)
			)
				return false;
			if (collection !== undefined) {
				validateIdentifier(collection, "collection");
				if (!(await hasImportBaselineTriggers(this.db, collection))) return false;
			} else {
				const collections = await this.db
					.selectFrom("_emdash_collections")
					.select("slug")
					.execute();
				if (collections.length === 0) return false;
				const readiness = await Promise.all(
					collections.map((row) => hasImportBaselineTriggers(this.db, row.slug)),
				);
				if (!readiness.every(Boolean)) return false;
			}
			const adapter = this.db.getExecutor().adapter;
			if ("executeAtomicBatch" in adapter && typeof adapter.executeAtomicBatch === "function")
				return true;
			// A stock D1 dialect can expose SqliteAdapter without supporting transactions.
			const rollback = new Error("Import transaction capability probe");
			try {
				await this.db.transaction().execute(async (trx) => {
					await sql`SELECT 1`.execute(trx);
					throw rollback;
				});
			} catch (error) {
				return error === rollback;
			}
			return false;
		} catch (error) {
			if (isMissingTableError(error)) return false;
			throw error;
		}
	}

	async available(collection?: string): Promise<boolean> {
		return this.supports(collection);
	}

	private async operation(operationId: string): Promise<OperationRow | null> {
		const result = await sql<OperationRow>`
			SELECT o.*, b.original_revision_id
			FROM _emdash_import_operations AS o
			LEFT JOIN _emdash_import_baselines AS b
				ON b.source_site = o.source_site AND b.source_type = o.source_type
				AND b.source_id = o.source_id AND b.locale = o.locale
				AND b.collection = o.collection AND b.entry_id = o.entry_id
			WHERE o.operation_id = ${operationId}
		`.execute(this.db);
		return result.rows[0] ?? null;
	}

	async lookup(operationId: string): Promise<ImportSyncApplied | null>;
	async lookup(
		operationId: string,
		identity: ImportSyncRequestIdentity,
	): Promise<ImportSyncResult | null>;
	async lookup(
		operationId: string,
		identity?: ImportSyncRequestIdentity,
	): Promise<ImportSyncResult | null> {
		if (!supportsAtomicImportSync(this.db)) return null;
		try {
			const row = await this.operation(operationId);
			return row ? (identity ? this.replay(row, identity) : applied(row, true)) : null;
		} catch (error) {
			if (isMissingTableError(error)) return null;
			throw error;
		}
	}

	private replay(row: OperationRow, input: ImportSyncRequestIdentity): ImportSyncResult {
		if (
			row.source_site !== input.source.site ||
			row.source_type !== input.source.type ||
			row.source_id !== input.source.id ||
			row.collection !== input.collection ||
			row.locale !== input.locale ||
			row.sequence !== input.sequence ||
			row.request_hash !== input.requestHash ||
			((row.grant_id != null || row.grant_generation != null || row.binding_id != null) &&
				(row.grant_id !== input.grant?.id ||
					row.grant_generation !== input.grant?.generation ||
					row.binding_id !== input.grant?.bindingId)) ||
			(input.entryId !== undefined && row.entry_id !== input.entryId)
		) {
			return { state: "conflict", reason: "operation_identity_mismatch" };
		}
		return applied(row, true);
	}

	async apply(input: ImportSyncInput): Promise<ImportSyncResult> {
		if (!supportsAtomicImportSync(this.db)) {
			return { state: "unknown", reason: "atomic_import_unavailable" };
		}
		validateIdentifier(input.collection, "collection");
		const prior = await this.lookup(input.operationId, input);
		if (prior) return prior;
		if (
			!input.operationId ||
			!input.source.site ||
			!input.source.id ||
			!["page", "post"].includes(input.source.type) ||
			!input.locale ||
			!input.slug ||
			!input.requestHash ||
			!input.authorId ||
			!input.grant?.id ||
			!input.grant.bindingId ||
			!Number.isSafeInteger(input.grant.generation) ||
			input.grant.generation < 1 ||
			!Array.isArray(input.mappedFields) ||
			new Set(input.mappedFields).size !== input.mappedFields.length ||
			!Number.isSafeInteger(input.sequence) ||
			input.sequence < 1 ||
			(input.expectedVersion !== undefined &&
				(!input.entryId ||
					!Number.isSafeInteger(input.expectedVersion) ||
					input.expectedVersion < 1 ||
					input.expectedVersion >= Number.MAX_SAFE_INTEGER))
		) {
			return { state: "conflict", reason: "invalid_import_input" };
		}
		const fields = Object.entries(input.data);
		for (const field of input.mappedFields) {
			validateIdentifier(field, "mapped content field");
			if (!Object.hasOwn(input.data, field)) {
				return { state: "conflict", reason: "mapped_field_missing_from_snapshot" };
			}
		}
		for (const [field] of fields) {
			validateIdentifier(field, "content field");
			if (SYSTEM_COLUMNS.has(field)) {
				return { state: "conflict", reason: "system_column_in_import_data" };
			}
		}

		try {
			if (!(await this.supports(input.collection))) {
				return { state: "unknown", reason: "import_provenance_unavailable" };
			}
			return await this.applyAtomic(input, fields);
		} catch (error) {
			if (isMissingTableError(error)) {
				return { state: "unknown", reason: "import_provenance_unavailable" };
			}
			throw error;
		}
	}

	private async applyAtomic(
		input: ImportSyncInput,
		fields: [string, unknown][],
	): Promise<ImportSyncResult> {
		const prior = await this.operation(input.operationId);
		if (prior) return this.replay(prior, input);

		const table = `ec_${input.collection}`;
		const entryId = input.entryId ?? ulid();
		const revisionId = createRevisionId();
		const updating = input.expectedVersion !== undefined;
		const version = updating ? (input.expectedVersion ?? 0) + 1 : 1;
		const now = new Date().toISOString();
		const publishedAt = input.publishedAt ?? now;
		const mappedFields = new Set(input.mappedFields);
		const writtenFields = fields.filter(([field]) => mappedFields.has(field));
		let revisionSnapshot = sql`${JSON.stringify({ ...input.data, _slug: input.slug })}`;
		let columnWitness = sql`1 = 1`;
		if (updating) {
			const definition = await sql<{
				sql: string;
			}>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(this.db);
			if (!definition.rows[0]) return { state: "unknown", reason: "import_provenance_unavailable" };
			columnWitness = sql`EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table'
				AND name = ${table} AND sql = ${definition.rows[0].sql})`;
			const columns = await sql<{ name: string }>`PRAGMA table_info(${sql.ref(table)})`.execute(
				this.db,
			);
			const dataColumns = columns.rows
				.map((column) => column.name)
				.filter((column) => !SYSTEM_COLUMNS.has(column));
			const entries = dataColumns.flatMap((field) => {
				validateIdentifier(field, "stored content field");
				const current = sql.ref(`c.${field}`);
				const path = sql.lit(`$.${field}`);
				const fieldType = sql`json_extract(field_types.data, ${path})`;
				const value = mappedFields.has(field)
					? sql`json(${JSON.stringify(input.data[field] ?? null)})`
					: sql`CASE WHEN json_type(snapshot_base.data, ${path}) IN ('object', 'array') THEN json(${current})
						WHEN json_type(snapshot_base.data, ${path}) IN ('true', 'false') THEN CASE ${current}
							WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE NULL END
						WHEN json_type(snapshot_base.data, ${path}) IS NOT NULL THEN ${current}
						WHEN ${fieldType} = 'boolean' THEN CASE ${current}
							WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE NULL END
						WHEN ${fieldType} IN ('json', 'portableText', 'multiSelect', 'repeater', 'blocks') THEN json(${current})
						ELSE ${current} END`;
				return [sql.lit(field), value];
			});
			revisionSnapshot = sql`(SELECT json_object(${sql.join([...entries, sql.lit("_slug"), sql`${input.slug}`])})
				FROM revisions AS snapshot_base
				CROSS JOIN (SELECT json_group_object(f.slug, f.type) AS data
					FROM _emdash_fields AS f JOIN _emdash_collections AS collection ON collection.id = f.collection_id
					WHERE collection.slug = ${input.collection}) AS field_types
				WHERE snapshot_base.id = c.live_revision_id
				AND snapshot_base.collection = ${input.collection} AND snapshot_base.entry_id = c.id)`;
		}
		const sourceMatch = sql`b.source_site = ${input.source.site}
			AND b.source_type = ${input.source.type} AND b.source_id = ${input.source.id}
			AND b.locale = ${input.locale}`;
		// The revision nonce prevents an operation-id replay from borrowing a pending guard.
		const pending = sql`EXISTS (
			SELECT 1 FROM _emdash_import_operations
			WHERE operation_id = ${input.operationId} AND revision_id = ${revisionId}
			AND completed = 0
		)`;
		const vacantSlug = sql`NOT EXISTS (
			SELECT 1 FROM ${sql.ref(table)}
			WHERE slug = ${input.slug} AND locale = ${input.locale} AND id <> ${entryId}
		)`;
		const eligible = updating
			? sql`EXISTS (
			SELECT 1 FROM _emdash_import_baselines AS b
			JOIN ${sql.ref(table)} AS c ON c.id = b.entry_id AND c.locale = b.locale
			JOIN _emdash_import_operations AS previous ON previous.operation_id = b.last_operation_id
			WHERE ${sourceMatch} AND b.collection = ${input.collection} AND b.entry_id = ${entryId}
			AND b.customer_owned = 0 AND b.last_sequence < ${input.sequence}
			AND b.version = ${input.expectedVersion} AND c.version = b.version
			AND c.live_revision_id = b.live_revision_id AND c.draft_revision_id IS NULL
			AND c.deleted_at IS NULL AND c.scheduled_at IS NULL AND c.status = 'published'
			AND previous.completed = 1 AND previous.collection = b.collection
			AND previous.entry_id = b.entry_id AND previous.locale = b.locale
			AND previous.source_site = b.source_site AND previous.source_type = b.source_type
			AND previous.source_id = b.source_id AND previous.sequence = b.last_sequence
			AND previous.version = b.version AND previous.revision_id = b.live_revision_id
			AND EXISTS (SELECT 1 FROM revisions WHERE id = b.original_revision_id
				AND collection = b.collection AND entry_id = b.entry_id)
			AND EXISTS (SELECT 1 FROM revisions WHERE id = b.live_revision_id
				AND collection = b.collection AND entry_id = b.entry_id)
		)`
			: sql`NOT EXISTS (
			SELECT 1 FROM _emdash_import_baselines AS b WHERE ${sourceMatch}
		) AND NOT EXISTS (SELECT 1 FROM ${sql.ref(table)} WHERE id = ${entryId})
		AND NOT EXISTS (SELECT 1 FROM _emdash_import_baselines
			WHERE collection = ${input.collection} AND entry_id = ${entryId})`;
		const columns = [
			"id",
			"slug",
			"status",
			"author_id",
			"created_at",
			"updated_at",
			"published_at",
			"version",
			"locale",
			"translation_group",
			"live_revision_id",
			"draft_revision_id",
			"scheduled_at",
			"deleted_at",
			...fields.map(([field]) => field),
		];
		const values = [
			entryId,
			input.slug,
			"published",
			input.authorId,
			input.createdAt ?? now,
			now,
			publishedAt,
			version,
			input.locale,
			entryId,
			revisionId,
			null,
			null,
			null,
			...fields.map(([, value]) => storedValue(value)),
		];
		const assignments = [
			sql`slug = ${input.slug}`,
			sql`status = 'published'`,
			sql`author_id = ${input.authorId}`,
			sql`updated_at = ${now}`,
			sql`published_at = ${input.publishedAt ?? sql`published_at`}`,
			sql`version = ${version}`,
			sql`live_revision_id = ${revisionId}`,
			sql`draft_revision_id = NULL`,
			sql`scheduled_at = NULL`,
			...input.mappedFields.map(
				(field) => sql`${sql.ref(field)} = ${storedValue(input.data[field])}`,
			),
		];
		const content = updating
			? sql`
			UPDATE ${sql.ref(table)} SET ${sql.join(assignments, sql`, `)}
			WHERE id = ${entryId} AND locale = ${input.locale}
			AND version = ${input.expectedVersion} AND ${pending}
			RETURNING id
		`
			: sql`
			INSERT INTO ${sql.ref(table)} (${sql.join(columns.map((column) => sql.ref(column)))})
			SELECT ${sql.join(values.map((value) => sql`${value}`))} WHERE ${pending}
			RETURNING id
		`;
		const baseline = updating
			? sql`
			UPDATE _emdash_import_baselines SET version = ${version}, live_revision_id = ${revisionId},
				last_sequence = ${input.sequence}, last_operation_id = ${input.operationId}, customer_owned = 0
			WHERE source_site = ${input.source.site} AND source_type = ${input.source.type}
			AND source_id = ${input.source.id} AND locale = ${input.locale}
			AND collection = ${input.collection} AND entry_id = ${entryId}
			AND version = ${input.expectedVersion} AND ${pending}
			RETURNING entry_id
		`
			: sql`
			INSERT INTO _emdash_import_baselines
				(source_site, source_type, source_id, collection, entry_id, locale, original_revision_id,
				version, live_revision_id, customer_owned, last_sequence, last_operation_id)
			SELECT ${input.source.site}, ${input.source.type}, ${input.source.id}, ${input.collection},
				${entryId}, ${input.locale}, ${revisionId}, ${version}, ${revisionId}, 0,
				${input.sequence}, ${input.operationId} WHERE ${pending}
			RETURNING entry_id
		`;
		const revision = updating
			? sql`
			INSERT INTO revisions (id, collection, entry_id, data, author_id)
			SELECT ${revisionId}, ${input.collection}, ${entryId}, ${revisionSnapshot}, ${input.authorId}
			FROM ${sql.ref(table)} AS c
			WHERE c.id = ${entryId} AND c.locale = ${input.locale} AND ${pending} RETURNING id
		`
			: sql`
			INSERT INTO revisions (id, collection, entry_id, data, author_id)
			SELECT ${revisionId}, ${input.collection}, ${entryId}, ${revisionSnapshot}, ${input.authorId}
			WHERE ${pending} RETURNING id
		`;
		const queries = [
			sql`
				INSERT INTO _emdash_import_operations
					(operation_id, source_site, source_type, source_id, collection, entry_id, locale,
					sequence, request_hash, revision_id, version, completed, grant_id, grant_generation, binding_id)
				SELECT ${input.operationId}, ${input.source.site}, ${input.source.type}, ${input.source.id},
					${input.collection}, ${entryId}, ${input.locale}, ${input.sequence}, ${input.requestHash},
					${revisionId}, ${version}, 0, ${input.grant.id}, ${input.grant.generation}, ${input.grant.bindingId}
				WHERE NOT EXISTS (SELECT 1 FROM _emdash_import_operations WHERE operation_id = ${input.operationId})
				AND ${eligible} AND ${vacantSlug} AND ${columnWitness}
				AND EXISTS (SELECT 1 FROM _emdash_import_grants AS grant_authority
					WHERE grant_authority.id = ${input.grant.id}
					AND grant_authority.source_site = ${input.source.site}
					AND grant_authority.binding_id = ${input.grant.bindingId}
					AND grant_authority.actor_id = ${input.authorId}
					AND grant_authority.generation = ${input.grant.generation}
					AND grant_authority.revoked = 0)
				AND ${importBaselineTriggerWitness(this.db, input.collection)}
				RETURNING operation_id
			`,
			revision,
			content,
			baseline,
			sql`
				INSERT INTO _emdash_revision_prune_queue (collection, entry_id, revision_id)
				SELECT ${input.collection}, ${entryId}, ${revisionId} WHERE ${pending}
				ON CONFLICT (collection, entry_id) DO UPDATE SET revision_id = excluded.revision_id
				RETURNING entry_id
			`,
			// A constraint failure, not a post-batch JS check, rolls back incomplete D1 writes.
			sql<OperationRow>`
				UPDATE _emdash_import_operations SET completed = CASE WHEN EXISTS (
					SELECT 1 FROM ${sql.ref(table)} AS c
					JOIN _emdash_import_baselines AS b ON b.entry_id = c.id AND b.collection = ${input.collection}
					JOIN revisions AS r ON r.id = c.live_revision_id
					WHERE ${sourceMatch} AND c.id = ${entryId} AND c.locale = ${input.locale}
					AND c.version = ${version} AND c.live_revision_id = ${revisionId}
					AND c.draft_revision_id IS NULL AND c.scheduled_at IS NULL AND c.deleted_at IS NULL
					AND c.status = 'published' AND c.slug = ${input.slug} AND c.author_id = ${input.authorId}
					AND ${
						(updating ? writtenFields : fields).length
							? sql.join(
									(updating ? writtenFields : fields).map(
										([field, value]) => sql`${sql.ref(`c.${field}`)} IS ${storedValue(value)}`,
									),
									sql` AND `,
								)
							: sql`1 = 1`
					}
					AND b.version = ${version} AND b.live_revision_id = ${revisionId} AND b.customer_owned = 0
					AND b.last_operation_id = ${input.operationId} AND b.last_sequence = ${input.sequence}
					AND r.collection = ${input.collection} AND r.entry_id = ${entryId}
					AND r.data = ${revisionSnapshot}
					AND r.author_id = ${input.authorId}
					AND EXISTS (SELECT 1 FROM _emdash_revision_prune_queue
						WHERE collection = ${input.collection} AND entry_id = ${entryId} AND revision_id = ${revisionId})
				) THEN 1 ELSE NULL END
				WHERE operation_id = ${input.operationId} AND revision_id = ${revisionId} AND completed = 0
				RETURNING operation_id
			`,
			sql<OperationRow>`
				SELECT o.*, CASE WHEN o.completed = 1 AND b.original_revision_id IS NOT NULL
					THEN b.original_revision_id ELSE json('incomplete atomic import') END AS original_revision_id
				FROM _emdash_import_operations AS o
				LEFT JOIN _emdash_import_baselines AS b
					ON b.collection = o.collection AND b.entry_id = o.entry_id
					AND b.source_site = o.source_site AND b.source_type = o.source_type
					AND b.source_id = o.source_id AND b.locale = o.locale
				WHERE o.operation_id = ${input.operationId} AND o.revision_id = ${revisionId}
			`,
		];

		let results = await executeAtomicBatchIfSupported(this.db, queries);
		if (!results) {
			results = await this.db.transaction().execute(async (trx) => {
				const executed: QueryResult<unknown>[] = [];
				for (const query of queries) {
					// oxlint-disable-next-line no-await-in-loop -- statements share a transaction-local guard
					executed.push(await query.execute(trx));
				}
				this.checkResults(executed);
				return executed;
			});
		}
		this.checkResults(results);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- atomic batch erases the final sql<OperationRow> result type
		const row = results[queries.length - 1]?.rows[0] as OperationRow | undefined;
		if (row) {
			invalidateCollectionCache(input.collection);
			return applied(row, false);
		}
		const concurrent = await this.operation(input.operationId);
		if (concurrent) return this.replay(concurrent, input);
		const baselineResult = await sql<{ customer_owned: number }>`
			SELECT b.customer_owned FROM _emdash_import_baselines AS b WHERE ${sourceMatch}
		`.execute(this.db);
		return baselineResult.rows.length === 0 && updating
			? { state: "unknown", reason: "source_baseline_unknown" }
			: { state: "conflict", reason: "import_precondition_failed" };
	}

	private checkResults(results: readonly QueryResult<unknown>[]): void {
		if (
			results.length !== 7 ||
			results.some((result) => result.rows.length !== results[0]?.rows.length)
		) {
			throw new Error("Incomplete atomic import result");
		}
		if (results[0].rows.length > 1) throw new Error("Ambiguous atomic import result");
	}
}
