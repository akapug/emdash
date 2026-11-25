import { sql, type Kysely } from "kysely";

import { currentTimestamp, isPostgres } from "../dialect-helpers.js";

/**
 * Stored image variants: the resized copies WordPress already generated, carried
 * so a page can ask for a small file instead of a full-size photograph.
 *
 * NUMBERING. Fork migrations are `embark_NNN_name` and the runner sorts them
 * within their own series, requiring the ledger to be the leading run of the
 * registered set (see `runner.ts`). This took the number 004 because 004 is the next
 * free slot in the series: a fork migration registered AFTER a gap makes the ledger
 * order check reject every later artifact that fills the gap, which is `runner.ts`'s
 * MigrationLedgerOrderError. This migration is registered in `runner.ts`.
 *
 * WHY A SEPARATE TABLE AND NOT A `media` COLUMN. One attachment has up to
 * eighteen sizes, each with its own bytes, dimensions and hash. A child row keeps
 * the parent's identity intact, lets a delete cascade the rows, and gives every
 * object one owner.
 *
 * IDENTITY IS NOT THE WIDTH. Two size names can share dimensions with different
 * bytes, and an in-place Replace deliberately keeps the parent's storage key
 * (`astro/routes/api/media/[id]/replace.ts`). So the row carries the variant's own
 * content hash AND the parent's, and the key is (parent, parent's hash, width):
 * the triple that is exactly unique. A duplicate of the same bytes replays; the
 * same slot with different bytes is a conflict the client reports.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_media_variants")
		.ifNotExists()
		// The parent. `on delete cascade` retires the rows with the image; the
		// OBJECT keys are recorded before the cascade runs, because a cascade cannot
		// tell anyone what to delete from storage.
		.addColumn("media_id", "text", (column) =>
			column.notNull().references("media.id").onDelete("cascade"),
		)
		// WordPress's own name (thumbnail | medium | large | <custom>). Provenance
		// only: a server cannot check it, because `media` carries no metadata column.
		.addColumn("size_name", "text", (column) => column.notNull())
		.addColumn("width", "integer", (column) => column.notNull())
		.addColumn("height", "integer", (column) => column.notNull())
		// An immutable object key, never a public address. The public URL is the
		// parent's, with `?w=`.
		.addColumn("storage_key", "text", (column) => column.notNull())
		.addColumn("bytes", "integer", (column) => column.notNull())
		// sha256 of the stored bytes. Same bytes at the same slot replays; different
		// bytes at the same slot is a conflict, never an overwrite.
		.addColumn("content_hash", "text", (column) => column.notNull())
		// The parent's content hash when this was committed; `media` has no version
		// column, and Replace rewrites content_hash, so this is the identity that
		// actually moves when the image behind a variant is replaced.
		.addColumn("parent_content_hash", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addPrimaryKeyConstraint("pk_emdash_media_variants", [
			"media_id",
			"parent_content_hash",
			"width",
		])
		.execute();

	// THE CLEANUP RECORD, and why it is a SEPARATE TABLE. `_emdash_media_variants`
	// cascades on parent delete, so a "retired" flag on those rows would die with the
	// parent and the object key would be lost — an orphan nothing can name. This table
	// has NO foreign key, so a record survives its parent and the sweeper can finish the
	// job after a crash. It is written in the SAME mutation that changes the parent, and
	// a pending candidate is recorded BEFORE the storage upload, so a store cut mid-way
	// is nameable too.
	await db.schema
		.createTable("_emdash_media_variant_cleanup")
		.ifNotExists()
		.addColumn("storage_key", "text", (column) => column.primaryKey())
		// Pending keys may still be publishing; retired keys are eligible for deletion.
		.addColumn("reason", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	// The primary key already indexes parent/hash/width for serving. Cleanup
	// needs the reverse lookup so each key can be checked without a table scan.
	await db.schema
		.createIndex("idx_emdash_media_variants_storage_key")
		.ifNotExists()
		.on("_emdash_media_variants")
		.column("storage_key")
		.execute();

	await installCustodyTriggers(db);
}

function recordRetired(keys: ReturnType<typeof sql>) {
	return sql`
		INSERT INTO _emdash_media_variant_cleanup (storage_key, reason)
		${keys}
		ON CONFLICT (storage_key) DO UPDATE SET reason = excluded.reason
	`;
}

async function installCustodyTriggers(db: Kysely<unknown>): Promise<void> {
	const postgres = isPostgres(db);
	const changed = postgres ? sql`IS DISTINCT FROM` : sql`IS NOT`;
	const leftReady = sql`OLD.status = 'ready' AND NEW.status <> 'ready'`;
	const parentChanged = sql`NEW.content_hash ${changed} OLD.content_hash OR (${leftReady})`;
	const obsolete = sql`
		media_id = OLD.id AND ((${leftReady}) OR parent_content_hash ${changed} NEW.content_hash)
	`;
	// Parent mutations delete the slots in the same statement. A single child
	// trigger retains the exact key whether the deletion came from a parent or
	// from a direct delete such as backfill rollback.
	const deleteBeforeCascade = sql`DELETE FROM _emdash_media_variants WHERE media_id = OLD.id`;
	const deleteObsolete = sql`DELETE FROM _emdash_media_variants WHERE ${obsolete}`;
	const retireDeleted = recordRetired(sql`VALUES (OLD.storage_key, 'retired')`);
	const consumePending = sql`
		DELETE FROM _emdash_media_variant_cleanup WHERE storage_key = NEW.storage_key AND reason = 'pending'
	`;
	const retireSwapped = recordRetired(sql`
		SELECT OLD.storage_key, 'retired' WHERE OLD.storage_key <> NEW.storage_key
	`);

	if (postgres) {
		await sql`
			CREATE OR REPLACE FUNCTION emdash_media_variant_parent_retire()
			RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF TG_OP = 'DELETE' THEN
					${deleteBeforeCascade};
					RETURN OLD;
				END IF;
				${deleteObsolete};
				RETURN NEW;
			END;
			$$
		`.execute(db);
		await sql`
			CREATE OR REPLACE TRIGGER emdash_media_variant_parent_delete
			BEFORE DELETE ON media
			FOR EACH ROW EXECUTE FUNCTION emdash_media_variant_parent_retire()
		`.execute(db);
		await sql`
			CREATE OR REPLACE TRIGGER emdash_media_variant_parent_update
			AFTER UPDATE OF content_hash, status ON media
			FOR EACH ROW WHEN (${parentChanged})
			EXECUTE FUNCTION emdash_media_variant_parent_retire()
		`.execute(db);
		await sql`
			CREATE OR REPLACE FUNCTION emdash_media_variant_track_key()
			RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF TG_OP = 'DELETE' THEN
					${retireDeleted};
					RETURN OLD;
				END IF;
				${consumePending};
				IF TG_OP = 'UPDATE' THEN
					${retireSwapped};
				END IF;
				RETURN NEW;
			END;
			$$
		`.execute(db);
		await sql`
			CREATE OR REPLACE TRIGGER emdash_media_variant_track_key
			AFTER INSERT OR UPDATE OF storage_key OR DELETE ON _emdash_media_variants
			FOR EACH ROW EXECUTE FUNCTION emdash_media_variant_track_key()
		`.execute(db);
		return;
	}

	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_media_variant_parent_delete
		BEFORE DELETE ON media
		BEGIN
			${deleteBeforeCascade};
		END
	`.execute(db);
	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_media_variant_parent_update
		AFTER UPDATE OF content_hash, status ON media
		WHEN ${parentChanged}
		BEGIN
			${deleteObsolete};
		END
	`.execute(db);
	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_media_variant_adopt_insert
		AFTER INSERT ON _emdash_media_variants
		BEGIN
			${consumePending};
		END
	`.execute(db);
	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_media_variant_adopt_update
		AFTER UPDATE OF storage_key ON _emdash_media_variants
		BEGIN
			${consumePending};
			${retireSwapped};
		END
	`.execute(db);
	await sql`
		CREATE TRIGGER IF NOT EXISTS emdash_media_variant_retire_delete
		AFTER DELETE ON _emdash_media_variants
		BEGIN
			${retireDeleted};
		END
	`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	throw new Error(
		"Media variants migration is forward-only; keep variant rows and cleanup records",
	);
}
