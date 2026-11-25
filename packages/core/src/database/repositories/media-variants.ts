import { sql, type Kysely } from "kysely";

import type { StoredVariant } from "../../media/variants.js";
import type { Database } from "../types.js";

/**
 * The stored sizes of an imported image.
 *
 * The rules this repository enforces, and why each is here rather than in a
 * route handler:
 *
 *  - **A duplicate of the same bytes replays; different bytes at the same slot
 *    is a conflict.** The primary key is `(media_id, parent_content_hash, width)`,
 *    so two size names at one width cannot both own the slot — and an in-place
 *    Replace deliberately keeps the parent's storage key, which is exactly why a
 *    width is not an identity on its own. The content hash decides which case a
 *    second write is.
 *  - **A stale generation is never served.** Rows carry the parent's generation;
 *    a row behind the parent's current generation belongs to bytes that no longer
 *    exist, so `forParent` filters it out rather than trusting a caller to.
 *  - **Retiring returns the keys it retired.** A delete cascade removes rows, and
 *    a cascade cannot tell anyone which objects to remove from storage — so the
 *    rows are selected BEFORE the delete and returned, and the caller retires the
 *    objects through the durable cleanup path.
 */

export type VariantStoreOutcome = "stored" | "replayed" | "conflict";

export class MediaVariantRepository {
	constructor(private readonly db: Kysely<Database>) {}

	/**
	 * Store one variant. Returns what happened, never a throw for the two
	 * expected outcomes:
	 *   `stored`   — the slot was free
	 *   `replayed` — the same bytes are already there (an idempotent retry)
	 *   `conflict` — a different variant owns this slot; the caller must report it
	 */
	async store(input: {
		mediaId: string;
		sizeName: string;
		width: number;
		height: number;
		storageKey: string;
		bytes: number;
		contentHash: string;
		parentContentHash: string;
	}): Promise<VariantStoreOutcome> {
		const existing = await this.db
			.selectFrom("_emdash_media_variants")
			.select(["content_hash"])
			.where("media_id", "=", input.mediaId)
			.where("parent_content_hash", "=", input.parentContentHash)
			.where("width", "=", input.width)
			.executeTakeFirst();
		if (existing) return existing.content_hash === input.contentHash ? "replayed" : "conflict";

		try {
			// W6: THE PREDICATE IS IN THE INSERT, not in a read before it. A
			// select-then-insert lets the parent's bytes change in between, and the row
			// would then claim to be a size of an image that no longer exists. An
			// INSERT ... SELECT gated on the parent's CURRENT content hash cannot: if the
			// image was replaced a moment ago, the SELECT matches nothing and nothing is
			// written.
			const inserted = await sql<{ inserted: number }>`
				INSERT INTO _emdash_media_variants
					(media_id, size_name, width, height, storage_key, bytes, content_hash, parent_content_hash, created_at)
				SELECT ${input.mediaId}, ${input.sizeName}, ${input.width}, ${input.height},
					${input.storageKey}, ${input.bytes}, ${input.contentHash}, ${input.parentContentHash},
					datetime('now')
				FROM media m
				WHERE m.id = ${input.mediaId}
					AND m.status = 'ready'
					AND m.content_hash = ${input.parentContentHash}
			`.execute(this.db);
			if (Number(inserted.numAffectedRows ?? 0) === 0) {
				// Nothing was inserted: the parent changed, or is not ready. That is a
				// conflict for the caller to report, never a silent success.
				return "conflict";
			}
			return "stored";
		} catch (error) {
			// A concurrent insert won the slot between the check and the write. Which
			// outcome it is still depends on the bytes, so ask again rather than guess.
			const raced = await this.db
				.selectFrom("_emdash_media_variants")
				.select(["content_hash"])
				.where("media_id", "=", input.mediaId)
				.where("parent_content_hash", "=", input.parentContentHash)
				.where("width", "=", input.width)
				.executeTakeFirst();
			if (raced) return raced.content_hash === input.contentHash ? "replayed" : "conflict";
			throw error;
		}
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

	/**
	 * Retire a parent's variants and RETURN the exact object keys so the caller can
	 * delete them durably. `generation` narrows to one generation (a Replace retires
	 * the generation it replaced); omitted, every generation goes (a Delete).
	 *
	 * The caller must delete the returned keys through the durable cleanup path, and
	 * must do it even if this returns an empty list — an empty list is a valid answer,
	 * not a reason to skip the cleanup record.
	 */
	async retire(mediaId: string, parentContentHash?: string): Promise<string[]> {
		let query = this.db
			.selectFrom("_emdash_media_variants")
			.select(["storage_key"])
			.where("media_id", "=", mediaId);
		if (parentContentHash !== undefined) query = query.where("parent_content_hash", "=", parentContentHash);
		const doomed = (await query.execute()).map((row) => row.storage_key);
		if (!doomed.length) return [];

		let del = this.db.deleteFrom("_emdash_media_variants").where("media_id", "=", mediaId);
		if (parentContentHash !== undefined) del = del.where("parent_content_hash", "=", parentContentHash);
		await del.execute();
		return doomed;
	}

	/** How much the variant store holds for this tenant, for the import report's line. */
	async totals(): Promise<{ rows: number; bytes: number }> {
		const { rows } = await sql<{ n: number | null; b: number | null }>`
			SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM _emdash_media_variants`.execute(this.db);
		return { rows: Number(rows[0]?.n ?? 0), bytes: Number(rows[0]?.b ?? 0) };
	}
}
