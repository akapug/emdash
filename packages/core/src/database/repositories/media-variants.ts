import { sql, type Kysely } from "kysely";

import { invalidateVariants } from "../../media/variant-read.js";
import { VARIANT_SLOT_CAP, type StoredVariant } from "../../media/variants.js";
import { sha256Hex } from "../../transfer/format/digest.js";
import { executeAtomicBatchIfSupported, isPostgres } from "../dialect-helpers.js";
import type { Database } from "../types.js";

const PUBLICATION_ID_PREFIX = "media-variant-publication:v1:";

/**
 * Derive an opaque SHA-256 publication token from a variant's private storage key.
 * Each fresh POST allocates a new UUID-backed storage key, so identical bytes
 * re-uploaded after removal produce a different publicationId — and the raw
 * storage key is never exposed.
 */
export async function variantPublicationId(storageKey: string): Promise<string> {
	return sha256Hex(`${PUBLICATION_ID_PREFIX}${storageKey}`);
}

export type ExactVariantSkipReason = "not-the-stored-bytes" | "not-this-parent" | "absent";

export interface ExactVariantTarget {
	width: number;
	contentHash: string;
	publicationId: string;
}

type VariantSlot = Pick<StoredVariant, "mediaId" | "parentContentHash" | "width">;
type VariantCandidate = Omit<StoredVariant, "createdAt">;

export type VariantStoreOutcome =
	| { outcome: "stored" | "replayed"; storageKey: string }
	| { outcome: "conflict" | "variant-slot-cap" };

function classifyVariantInsert(row: unknown, capped: boolean): VariantStoreOutcome {
	if (row === undefined) return { outcome: capped ? "variant-slot-cap" : "conflict" };
	if (
		typeof row !== "object" ||
		row === null ||
		!("storage_key" in row) ||
		typeof row.storage_key !== "string"
	) {
		throw new Error("Variant insert returned an invalid storage key");
	}
	return { outcome: "stored", storageKey: row.storage_key };
}

/** Stored sizes are scoped to one ready parent generation and width. */
export class MediaVariantRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async findSlot(slot: VariantSlot) {
		return this.db
			.selectFrom("_emdash_media_variants as v")
			.innerJoin("media as m", "m.id", "v.media_id")
			.select(["v.content_hash as contentHash", "v.storage_key as storageKey"])
			.where("v.media_id", "=", slot.mediaId)
			.where("v.parent_content_hash", "=", slot.parentContentHash)
			.where("v.width", "=", slot.width)
			.whereRef("m.content_hash", "=", "v.parent_content_hash")
			.where("m.status", "=", "ready")
			.executeTakeFirst();
	}

	async registerCandidate(storageKey: string): Promise<void> {
		await this.db
			.insertInto("_emdash_media_variant_cleanup")
			.values({ storage_key: storageKey, reason: "pending" })
			.execute();
	}

	/** Only for a unique candidate whose publication definitively did not happen. */
	async retireCandidate(storageKey: string): Promise<void> {
		// The sweeper may already have removed the old marker before the PUT finished.
		// The UTC offset distinguishes a requeue from a sweep claim in the same millisecond.
		const marker = {
			reason: "retired",
			created_at: `${new Date().toISOString().slice(0, -1)}+00:00`,
		};
		await this.db
			.insertInto("_emdash_media_variant_cleanup")
			.values({ storage_key: storageKey, ...marker })
			.onConflict((oc) => oc.column("storage_key").doUpdateSet(marker))
			.execute();
	}

	/** Publish a candidate, or repair an observed missing key without rewriting it. */
	async store(input: VariantCandidate, missingStorageKey?: string): Promise<VariantStoreOutcome> {
		// The Postgres locks serialize with parent retirement and the sweep's pending
		// claim. SQLite/D1 serializes the single write. The adoption trigger consumes
		// the marker (and queues the old key on repair) in that same write.
		const locks = isPostgres(this.db) ? sql`FOR SHARE OF m FOR UPDATE OF c` : sql``;
		const admitted = sql`
			SELECT c.storage_key
			FROM media m
			JOIN _emdash_media_variant_cleanup c ON c.storage_key = ${input.storageKey}
			WHERE m.id = ${input.mediaId}
				AND m.status = 'ready'
				AND m.content_hash = ${input.parentContentHash}
				AND c.reason = 'pending'
			${locks}
		`;
		if (missingStorageKey !== undefined) {
			const { rows } = await sql<{ storage_key: string }>`
				UPDATE _emdash_media_variants
				SET storage_key = ${input.storageKey}
				WHERE media_id = ${input.mediaId}
					AND parent_content_hash = ${input.parentContentHash}
					AND width = ${input.width}
					AND content_hash = ${input.contentHash}
					AND storage_key = ${missingStorageKey}
					AND EXISTS (${admitted})
				RETURNING storage_key
			`.execute(this.db);
			if (!rows[0]) return { outcome: "conflict" };
			invalidateVariants();
			return { outcome: "replayed", storageKey: rows[0].storage_key };
		}

		const generation = sql`media_id = ${input.mediaId} AND parent_content_hash = ${input.parentContentHash}`;
		const full = sql`EXISTS (
			SELECT 1 FROM _emdash_media_variants WHERE ${generation}
			LIMIT 1 OFFSET ${VARIANT_SLOT_CAP - 1}
		)`;
		const insert = sql<{ storage_key: string }>`
			INSERT INTO _emdash_media_variants
				(media_id, size_name, width, height, storage_key, bytes, content_hash, parent_content_hash)
			SELECT ${input.mediaId}, ${input.sizeName}, ${input.width}, ${input.height},
				candidate.storage_key, ${input.bytes}, ${input.contentHash}, ${input.parentContentHash}
			FROM (${admitted}) AS candidate
			WHERE NOT ${full}
			ON CONFLICT (media_id, parent_content_hash, width) DO NOTHING
			RETURNING storage_key
		`;
		const refusedByCap = sql`
			SELECT 1 WHERE ${full} AND EXISTS (${admitted}) AND NOT EXISTS (
				SELECT 1 FROM _emdash_media_variants WHERE ${generation} AND width = ${input.width}
			)
		`;
		const write = async (db: Kysely<Database>) => {
			const { rows } = await insert.execute(db);
			return classifyVariantInsert(
				rows[0],
				!rows[0] && (await refusedByCap.execute(db)).rows.length > 0,
			);
		};

		let result: VariantStoreOutcome;
		if (isPostgres(this.db)) {
			// Lock before starting the INSERT so its snapshot sees the previous writer's commit.
			result = await this.db
				.transaction()
				.setIsolationLevel("read committed")
				.execute(async (db) => {
					const parent = await sql`SELECT id FROM media
						WHERE id = ${input.mediaId} AND status = 'ready' AND content_hash = ${input.parentContentHash}
						FOR NO KEY UPDATE`.execute(db);
					return parent.rows.length ? write(db) : { outcome: "conflict" };
				});
		} else {
			// SQLite serializes the guarded INSERT itself. D1 can also batch its diagnosis.
			const batch = await executeAtomicBatchIfSupported(this.db, [insert, refusedByCap]);
			result = batch
				? classifyVariantInsert(batch[0]?.rows[0], (batch[1]?.rows.length ?? 0) > 0)
				: await write(this.db);
		}
		if (result.outcome === "stored") invalidateVariants();
		return result;
	}

	/** Every committed variant of the parent's CURRENT generation. Stale rows are not returned. */
	async forParent(mediaId: string, parentContentHash: string): Promise<StoredVariant[]> {
		const rows = await this.db
			.selectFrom("_emdash_media_variants")
			.select([
				"media_id as mediaId",
				"size_name as sizeName",
				"width",
				"height",
				"storage_key as storageKey",
				"bytes",
				"content_hash as contentHash",
				"parent_content_hash as parentContentHash",
				"created_at as createdAt",
			])
			.where("media_id", "=", mediaId)
			.where("parent_content_hash", "=", parentContentHash)
			.execute();
		return [...rows] as StoredVariant[];
	}

	/** How much the variant store holds for this tenant, for the import report's line. */
	async totals(): Promise<{ rows: number; bytes: number }> {
		const { rows } = await sql<{ n: number | null; b: number | null }>`
			SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM _emdash_media_variants`.execute(
			this.db,
		);
		return { rows: Number(rows[0]?.n ?? 0), bytes: Number(rows[0]?.b ?? 0) };
	}

	/**
	 * Delete stored variant rows for a parent media item (optionally filtered to
	 * specific widths). Deletes rows ONLY so the database trigger queues each
	 * retired storage key into `_emdash_media_variant_cleanup`.
	 */
	async deleteForMedia(
		mediaId: string,
		widths?: readonly number[],
	): Promise<Array<{ width: number; contentHash: string }>> {
		if (widths !== undefined && widths.length === 0) return [];
		let query = this.db.deleteFrom("_emdash_media_variants").where("media_id", "=", mediaId);
		if (widths && widths.length > 0) {
			query = query.where("width", "in", [...widths]);
		}
		const rows = await query.returning(["width", "content_hash"]).execute();
		if (rows.length > 0) invalidateVariants();
		return rows.map((row) => ({ width: Number(row.width), contentHash: row.content_hash }));
	}

	/**
	 * Exact-match deletion for receipt-based rollback (item 144b).
	 * Deletes in ONE SQL statement only rows matching media_id, parent_content_hash,
	 * width, content_hash, and the storage_key whose opaque publicationId matches.
	 * Any concurrent replacement or identical-byte re-upload has a different
	 * storage_key / parent_content_hash and is left untouched.
	 */
	async deleteExact(
		mediaId: string,
		parentContentHash: string,
		currentParentContentHash: string,
		exact: readonly ExactVariantTarget[],
	): Promise<{
		removed: Array<{ width: number; contentHash: string }>;
		skipped: Array<{ width: number; why: ExactVariantSkipReason }>;
	}> {
		if (exact.length === 0) return { removed: [], skipped: [] };

		const existing = await this.db
			.selectFrom("_emdash_media_variants")
			.select(["width", "content_hash", "parent_content_hash", "storage_key"])
			.where("media_id", "=", mediaId)
			.execute();

		const existingWithPub = await Promise.all(
			existing.map(async (row) => ({
				width: Number(row.width),
				contentHash: row.content_hash,
				parentContentHash: row.parent_content_hash,
				storageKey: row.storage_key,
				publicationId: await variantPublicationId(row.storage_key),
			})),
		);

		const matchedTuples: Array<{ width: number; contentHash: string; storageKey: string }> = [];
		for (const target of exact) {
			const hit = existingWithPub.find(
				(row) =>
					row.parentContentHash === parentContentHash &&
					row.width === target.width &&
					row.contentHash === target.contentHash &&
					row.publicationId === target.publicationId,
			);
			if (hit) {
				matchedTuples.push({
					width: hit.width,
					contentHash: hit.contentHash,
					storageKey: hit.storageKey,
				});
			}
		}

		const removed: Array<{ width: number; contentHash: string }> = [];
		if (matchedTuples.length > 0) {
			const predicates = matchedTuples.map(
				(t) =>
					sql`(width = ${t.width} AND content_hash = ${t.contentHash} AND storage_key = ${t.storageKey})`,
			);
			const { rows } = await sql<{ width: number; content_hash: string }>`
				DELETE FROM _emdash_media_variants
				WHERE media_id = ${mediaId}
					AND parent_content_hash = ${parentContentHash}
					AND (${sql.join(predicates, sql` OR `)})
				RETURNING width, content_hash
			`.execute(this.db);
			if (rows.length > 0) invalidateVariants();
			for (const row of rows) {
				removed.push({ width: Number(row.width), contentHash: row.content_hash });
			}
		}

		const removedWidths = new Set(removed.map((r) => r.width));
		const skipped: Array<{ width: number; why: ExactVariantSkipReason }> = [];
		for (const target of exact) {
			if (removedWidths.has(target.width)) continue;
			const atWidth = existingWithPub.filter((row) => row.width === target.width);
			if (atWidth.some((row) => row.parentContentHash === parentContentHash)) {
				skipped.push({ width: target.width, why: "not-the-stored-bytes" });
			} else if (atWidth.length > 0 || currentParentContentHash !== parentContentHash) {
				skipped.push({ width: target.width, why: "not-this-parent" });
			} else {
				skipped.push({ width: target.width, why: "absent" });
			}
		}
		return { removed, skipped };
	}
}
