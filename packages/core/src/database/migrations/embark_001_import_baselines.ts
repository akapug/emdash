import { sql, type Kysely } from "kysely";

import {
	installImportBaselineCollectionTriggers,
	installImportBaselinePinTrigger,
	removeImportBaselineCollectionTriggers,
	supportsImportBaselineDialect,
} from "../import-baseline-triggers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_import_baselines")
		.ifNotExists()
		.addColumn("source_site", "text", (col) => col.notNull())
		.addColumn("source_type", "text", (col) => col.notNull())
		.addColumn("source_id", "text", (col) => col.notNull())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("entry_id", "text", (col) => col.notNull())
		.addColumn("locale", "text", (col) => col.notNull())
		.addColumn("original_revision_id", "text", (col) => col.notNull())
		.addColumn("version", "integer", (col) => col.notNull())
		.addColumn("live_revision_id", "text", (col) => col.notNull())
		.addColumn("customer_owned", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("last_sequence", "integer", (col) => col.notNull())
		.addColumn("last_operation_id", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("_emdash_import_baselines_pk", [
			"source_site",
			"source_type",
			"source_id",
			"locale",
		])
		.addUniqueConstraint("_emdash_import_baselines_entry_unique", ["collection", "entry_id"])
		.execute();
	await db.schema
		.createIndex("idx_emdash_import_baselines_original_revision_id")
		.ifNotExists()
		.on("_emdash_import_baselines")
		.column("original_revision_id")
		.execute();

	await db.schema
		.createTable("_emdash_import_operations")
		.ifNotExists()
		.addColumn("operation_id", "text", (col) => col.primaryKey())
		.addColumn("source_site", "text", (col) => col.notNull())
		.addColumn("source_type", "text", (col) => col.notNull())
		.addColumn("source_id", "text", (col) => col.notNull())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("entry_id", "text", (col) => col.notNull())
		.addColumn("locale", "text", (col) => col.notNull())
		.addColumn("sequence", "integer", (col) => col.notNull())
		.addColumn("request_hash", "text", (col) => col.notNull())
		.addColumn("revision_id", "text", (col) => col.notNull())
		.addColumn("version", "integer", (col) => col.notNull())
		.addColumn("completed", "integer", (col) => col.notNull().defaultTo(0))
		.addUniqueConstraint("_emdash_import_operations_revision_unique", ["revision_id"])
		.execute();
	await db.schema
		.createIndex("idx_emdash_import_operations_source")
		.ifNotExists()
		.on("_emdash_import_operations")
		.columns(["source_site", "source_type", "source_id", "locale"])
		.execute();

	if (!supportsImportBaselineDialect(db)) return;
	await installImportBaselinePinTrigger(db);
	const { rows } = await sql<{ slug: string }>`SELECT slug FROM _emdash_collections`.execute(db);
	for (const collection of rows) {
		// oxlint-disable-next-line no-await-in-loop -- collection DDL is independently restartable on D1
		await installImportBaselineCollectionTriggers(db, collection.slug);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (supportsImportBaselineDialect(db)) {
		const { rows } = await sql<{ slug: string }>`SELECT slug FROM _emdash_collections`.execute(db);
		for (const collection of rows) {
			// oxlint-disable-next-line no-await-in-loop -- shared-table triggers must go before their baseline table
			await removeImportBaselineCollectionTriggers(db, collection.slug);
		}
		await sql`DROP TRIGGER IF EXISTS emdash_import_original_pin`.execute(db);
	}
	await db.schema.dropTable("_emdash_import_operations").ifExists().execute();
	await db.schema.dropTable("_emdash_import_baselines").ifExists().execute();
}
