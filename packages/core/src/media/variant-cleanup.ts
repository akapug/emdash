import { sql, type Kysely } from "kysely";

import { isPostgres } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import type { Storage } from "../storage/types.js";
import {
	MEDIA_VARIANT_STORAGE_PREFIX,
	normalizeStorageKeyForGuard,
} from "../transfer/staging/keys.js";

const CLEANUP_BATCH_SIZE = 100;
// Match the upload-attempt grace period; a pending variant may still be publishing.
const PENDING_CLEANUP_AGE_MS = 60 * 60 * 1000;

export async function cleanupMediaVariants(db: Kysely<Database>, storage: Storage): Promise<void> {
	const now = new Date();
	const cutoff = new Date(now.getTime() - PENDING_CLEANUP_AGE_MS).toISOString();
	const unreferenced = sql<boolean>`
		NOT EXISTS (SELECT 1 FROM _emdash_media_variants
			WHERE _emdash_media_variants.storage_key = _emdash_media_variant_cleanup.storage_key)
		AND NOT EXISTS (SELECT 1 FROM media
			WHERE media.storage_key = _emdash_media_variant_cleanup.storage_key)`;
	// Pending rows can use an ISO timestamp or the database's text timestamp default.
	const expired = isPostgres(db)
		? sql<boolean>`CAST(created_at AS timestamptz) < CAST(${cutoff} AS timestamptz)`
		: sql<boolean>`julianday(created_at) < julianday(${cutoff})`;
	const eligible = sql<boolean>`(reason = 'retired' OR (reason = 'pending' AND ${expired}))`;

	const batch = db
		.selectFrom("_emdash_media_variant_cleanup")
		.select("storage_key")
		.where(eligible)
		.where(unreferenced)
		.where(
			sql<boolean>`substr(storage_key, 1, ${MEDIA_VARIANT_STORAGE_PREFIX.length}) = ${MEDIA_VARIANT_STORAGE_PREFIX}`,
		)
		.orderBy("created_at")
		.orderBy("storage_key")
		.limit(CLEANUP_BATCH_SIZE);

	// Publication consumes a pending marker in the same database write as it adds
	// the variant reference. Claiming it as retired wins that race or sees no row.
	// Refresh the queue time so failed deletions do not pin a full batch forever.
	const claimed = await db
		.updateTable("_emdash_media_variant_cleanup")
		.set({ reason: "retired", created_at: now.toISOString() })
		.where("storage_key", "in", batch)
		.where(eligible)
		.where(unreferenced)
		.returning(["storage_key", "created_at"])
		.execute();

	for (const { storage_key: storageKey, created_at: claimedAt } of claimed) {
		if (
			!storageKey.startsWith(MEDIA_VARIANT_STORAGE_PREFIX) ||
			normalizeStorageKeyForGuard(storageKey) === null
		) {
			continue;
		}
		try {
			await storage.delete(storageKey);
		} catch (error) {
			console.error(`[cleanup] Failed to delete media variant ${storageKey}:`, error);
			continue;
		}
		await db
			.deleteFrom("_emdash_media_variant_cleanup")
			.where("storage_key", "=", storageKey)
			.where("reason", "=", "retired")
			.where("created_at", "=", claimedAt)
			.execute();
	}
}
