import { sql, type Kysely } from "kysely";

import { tableExists } from "../dialect-helpers.js";

/**
 * Stored image variants: the resized copies WordPress already generated, carried
 * so a page can ask for a small file instead of a full-size photograph.
 *
 * NUMBERING. Fork migrations are `embark_NNN_name` and the runner sorts them
 * within their own series, requiring the ledger to be the leading run of the
 * registered set (see `runner.ts`). `embark_004` belongs to another lane, so this
 * is `005` and is registered after it. Adding a migration is a FILE AND A LINE IN
 * `runner.ts`; the line is in the same commit as this file.
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
		.addColumn("media_id", "text", (column) => column.notNull().references("media.id").onDelete("cascade"))
		// WordPress's own name (thumbnail | medium | large | <custom>). Provenance
		// only: a server cannot check it, because `media` carries no metadata column.
		.addColumn("size_name", "text", (column) => column.notNull())
		.addColumn("width", "integer", (column) => column.notNull())
		.addColumn("height", "integer", (column) => column.notNull())
		// The object's own immutable identity: a ULID. Deliberately NOT a public
		// key — nothing routes to it. The public URL is the parent's, with `?w=`.
		.addColumn("storage_key", "text", (column) => column.notNull())
		.addColumn("bytes", "integer", (column) => column.notNull())
		// sha256 of the stored bytes. Same bytes at the same slot replays; different
		// bytes at the same slot is a conflict, never an overwrite.
		.addColumn("content_hash", "text", (column) => column.notNull())
		// The parent's content hash when this was committed; `media` has no version
		// column, and Replace rewrites content_hash, so this is the identity that
		// actually moves when the image behind a variant is replaced.
		.addColumn("parent_content_hash", "text", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(sql`(datetime('now'))`))
		.addPrimaryKeyConstraint("pk_emdash_media_variants", ["media_id", "parent_content_hash", "width"])
		.execute();

	// Resolving `?w=` reads by parent and its content hash, then picks a width.
	await db.schema
		.createIndex("idx_emdash_media_variants_parent")
		.ifNotExists()
		.on("_emdash_media_variants")
		.columns(["media_id", "parent_content_hash", "width"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const table = "_emdash_media_variants";
	if (!(await tableExists(db, table))) return;
	// Refuse to drop a populated table silently: the objects behind these rows
	// live in storage, and dropping the rows without retiring the objects orphans
	// them with nothing left to name them.
	const used = (await sql`SELECT 1 FROM ${sql.ref(table)} LIMIT 1`.execute(db)).rows.length > 0;
	if (used)
		throw new Error(
			"Stored media variants exist; retire their objects through the cleanup path before dropping this table",
		);
	await db.schema.dropTable(table).execute();
}
