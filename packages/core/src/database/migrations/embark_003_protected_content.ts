import { sql, type Kysely } from "kysely";

import { isMissingTableError } from "../../utils/db-errors.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_protected_content")
		.ifNotExists()
		.addColumn("collection", "text", (column) => column.notNull())
		.addColumn("content_id", "text", (column) => column.notNull())
		.addColumn("credential_version", "integer", (column) => column.notNull().defaultTo(1))
		.addColumn("verifier", "text", (column) => column.notNull())
		.addColumn("data", "text", (column) => column.notNull())
		.addColumn("seo", "text")
		.addPrimaryKeyConstraint("pk_emdash_protected_content", ["collection", "content_id"])
		.execute();
	await db.schema
		.createTable("_emdash_protected_revisions")
		.ifNotExists()
		.addColumn("revision_id", "text", (column) => column.primaryKey())
		.addColumn("collection", "text", (column) => column.notNull())
		.addColumn("content_id", "text", (column) => column.notNull())
		.addColumn("data", "text", (column) => column.notNull())
		.execute();
	await db.schema
		.createIndex("idx_emdash_protected_revisions_content")
		.ifNotExists()
		.on("_emdash_protected_revisions")
		.columns(["collection", "content_id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const table of ["_emdash_protected_content", "_emdash_protected_revisions"]) {
		try {
			const used = (await sql`SELECT 1 FROM ${sql.ref(table)} LIMIT 1`.execute(db)).rows.length > 0;
			if (used)
				throw new Error(
					"Protected content exists; retain the capable runtime and private payload tables",
				);
		} catch (error) {
			if (!isMissingTableError(error)) throw error;
		}
	}
	await db.schema.dropTable("_emdash_protected_revisions").ifExists().execute();
	await db.schema.dropTable("_emdash_protected_content").ifExists().execute();
}
