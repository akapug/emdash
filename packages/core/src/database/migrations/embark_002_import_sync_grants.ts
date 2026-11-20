import { sql, type Kysely } from "kysely";

import { columnExists, currentTimestamp } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_import_grants")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("source_site", "text", (column) => column.notNull())
		.addColumn("binding_id", "text", (column) => column.notNull())
		.addColumn("actor_id", "text", (column) => column.notNull())
		.addColumn("generation", "integer", (column) => column.notNull().defaultTo(1))
		.addColumn("revoked", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("created_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (column) => column.notNull().defaultTo(currentTimestamp(db)))
		.addCheckConstraint("_emdash_import_grants_generation_positive", sql`generation > 0`)
		.addCheckConstraint("_emdash_import_grants_revoked_boolean", sql`revoked IN (0, 1)`)
		.execute();

	for (const [name, type] of [
		["grant_id", "text"],
		["grant_generation", "integer"],
		["binding_id", "text"],
	] as const) {
		// oxlint-disable-next-line no-await-in-loop -- each D1 column addition can complete independently
		if (await columnExists(db, "_emdash_import_operations", name)) continue;
		// oxlint-disable-next-line no-await-in-loop -- each D1 column addition can complete independently
		await db.schema.alterTable("_emdash_import_operations").addColumn(name, type).execute();
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Grant tombstones and operation authority receipts must survive an application rollback.
}
