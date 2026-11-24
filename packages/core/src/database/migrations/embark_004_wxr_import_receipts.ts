import { sql, type Kysely } from "kysely";

import { tableExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_wxr_import_receipts")
		.ifNotExists()
		.addColumn("operation_id", "text", (col) => col.primaryKey())
		.addColumn("source_lineage", "text", (col) => col.notNull())
		.addColumn("source_post_id", "text", (col) => col.notNull())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("entry_id", "text", (col) => col.notNull())
		.addColumn("slug", "text", (col) => col.notNull())
		.addColumn("locale", "text", (col) => col.notNull())
		.addColumn("translation_group", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("input_fingerprint", "text", (col) => col.notNull())
		.addColumn("stored_data_hash", "text", (col) => col.notNull())
		.addColumn("committed_hash", "text", (col) => col.notNull())
		.addColumn("has_seo", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("has_protected", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("protected_seo_json", "text")
		.addColumn("receipt_state", "text", (col) =>
			col
				.notNull()
				.defaultTo("finished")
				.check(sql`receipt_state = 'finished'`),
		)
		.addColumn("created_at", "text", (col) => col.notNull())
		.addUniqueConstraint("_emdash_wxr_import_receipts_source_unique", [
			"source_lineage",
			"source_post_id",
			"locale",
		])
		.addUniqueConstraint("_emdash_wxr_import_receipts_entry_unique", ["collection", "entry_id"])
		.execute();

	await db.schema
		.createIndex("idx_emdash_wxr_import_receipts_group")
		.ifNotExists()
		.on("_emdash_wxr_import_receipts")
		.columns(["collection", "translation_group"])
		.execute();

	await db.schema
		.createTable("_emdash_wxr_group_baselines")
		.ifNotExists()
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("translation_group", "text", (col) => col.notNull())
		.addColumn("source_lineage", "text", (col) => col.notNull())
		.addColumn("source_group_id", "text")
		.addColumn("anchor_entry_id", "text", (col) => col.notNull())
		.addColumn("anchor_updated_at", "text", (col) => col.notNull())
		.addColumn("anchor_seo_json", "text")
		.addColumn("anchor_bylines_json", "text", (col) => col.notNull().defaultTo("[]"))
		.addColumn("generation", "integer", (col) => col.notNull().defaultTo(1))
		.addColumn("anchor_state_hash", "text", (col) => col.notNull())
		.addColumn("terms_json", "text", (col) => col.notNull())
		.addColumn("last_operation_id", "text", (col) => col.notNull())
		.addColumn("updated_at", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("_emdash_wxr_group_baselines_pk", ["collection", "translation_group"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const table of ["_emdash_wxr_group_baselines", "_emdash_wxr_import_receipts"]) {
		if (!(await tableExists(db, table))) continue;
		const used = (await sql`SELECT 1 FROM ${sql.ref(table)} LIMIT 1`.execute(db)).rows.length > 0;
		if (used) {
			throw new Error("WXR import receipts exist; retain the atomic import receipt tables");
		}
	}
	await db.schema.dropTable("_emdash_wxr_group_baselines").ifExists().execute();
	await db.schema.dropTable("_emdash_wxr_import_receipts").ifExists().execute();
}
