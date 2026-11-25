import { sql, type Kysely } from "kysely";

import { invalidateVariants } from "../../media/variant-read.js";
import type { StoredVariant } from "../../media/variants.js";
import { isPostgres } from "../dialect-helpers.js";
import type { Database } from "../types.js";

type VariantSlot = Pick<StoredVariant, "mediaId" | "parentContentHash" | "width">;
type VariantCandidate = Omit<StoredVariant, "createdAt">;

export type VariantStoreOutcome =
	| { outcome: "stored" | "replayed"; storageKey: string }
	| { outcome: "conflict" };

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
		const statement =
			missingStorageKey === undefined
				? sql<{ storage_key: string }>`
					INSERT INTO _emdash_media_variants
						(media_id, size_name, width, height, storage_key, bytes, content_hash, parent_content_hash)
					SELECT ${input.mediaId}, ${input.sizeName}, ${input.width}, ${input.height},
						candidate.storage_key, ${input.bytes}, ${input.contentHash}, ${input.parentContentHash}
					FROM (${admitted}) AS candidate
					WHERE true
					ON CONFLICT (media_id, parent_content_hash, width) DO NOTHING
					RETURNING storage_key
				`
				: sql<{ storage_key: string }>`
					UPDATE _emdash_media_variants
					SET storage_key = ${input.storageKey}
					WHERE media_id = ${input.mediaId}
						AND parent_content_hash = ${input.parentContentHash}
						AND width = ${input.width}
						AND content_hash = ${input.contentHash}
						AND storage_key = ${missingStorageKey}
						AND EXISTS (${admitted})
					RETURNING storage_key
				`;
		const { rows } = await statement.execute(this.db);
		const committed = rows[0];
		if (!committed) return { outcome: "conflict" };
		invalidateVariants();
		return {
			outcome: missingStorageKey === undefined ? "stored" : "replayed",
			storageKey: committed.storage_key,
		};
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
}
