import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	hasImportBaselineTriggers,
	markImportBaselineCustomerOwned,
	supportsImportBaselineDialect,
} from "../../../src/database/import-baseline-triggers.js";
import { up } from "../../../src/database/migrations/embark_001_import_baselines.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { importBaselineCases, seedImportBaseline } from "../../utils/import-baseline-cases.js";
import {
	createTestDatabase,
	setupTestDatabase,
	teardownTestDatabase,
} from "../../utils/test-db.js";

describe("import baseline invalidation and retention on SQLite", () => {
	let db: Kysely<Database>;
	beforeEach(async () => {
		db = await setupTestDatabase();
		await seedImportBaseline(db);
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});
	importBaselineCases(() => db);

	async function ownedCount(): Promise<number> {
		const row = await db
			.selectFrom("_emdash_import_baselines")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("customer_owned", "=", 1)
			.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	it("still reads as installed after every table its triggers name is renamed and restored", async () => {
		for (const table of [
			"revisions",
			"_emdash_import_baselines",
			"_emdash_content_bylines",
			"content_taxonomies",
			"_emdash_bylines",
		]) {
			// SQLite rewrites each reference to a renamed table as a quoted identifier.
			// oxlint-disable-next-line no-await-in-loop -- one rename round trip per table
			await sql`ALTER TABLE ${sql.table(table)} RENAME TO ${sql.table(`${table}_staged`)}`.execute(
				db,
			);
			// oxlint-disable-next-line no-await-in-loop -- one rename round trip per table
			await sql`ALTER TABLE ${sql.table(`${table}_staged`)} RENAME TO ${sql.table(table)}`.execute(
				db,
			);
		}

		expect(await hasImportBaselineTriggers(db, "post")).toBe(true);
		await up(db);
		expect(await ownedCount()).toBe(0);
	});

	it("accepts the bare table names an earlier install wrote", async () => {
		const { rows } = await sql<{ name: string; sql: string }>`SELECT name, sql FROM sqlite_master
			WHERE type = 'trigger' AND name LIKE 'emdash_import_%'`.execute(db);
		expect(rows.length).toBeGreaterThan(20);
		for (const row of rows) {
			// Earlier installs quoted only a collection trigger's ON target.
			const bare = row.sql
				.replaceAll('"revisions"', "revisions")
				.replaceAll(
					/(?<!ON )"(_emdash_import_baselines|_emdash_content_bylines|content_taxonomies|_emdash_bylines)"/g,
					"$1",
				);
			expect(bare).not.toBe(row.sql);
			// oxlint-disable-next-line no-await-in-loop -- replace each trigger with its earlier text
			await sql`DROP TRIGGER ${sql.ref(row.name)}`.execute(db);
			// oxlint-disable-next-line no-await-in-loop -- replace each trigger with its earlier text
			await sql.raw(bare).execute(db);
		}

		expect(await hasImportBaselineTriggers(db, "post")).toBe(true);
		await up(db);
		expect(await ownedCount()).toBe(0);
	});
});

describe("import baseline schema expansion", () => {
	let db: Kysely<Database>;
	beforeEach(() => {
		db = createTestDatabase();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("installs on existing collections, restarts after individual statements and leaves legacy content unknown", async () => {
		const { error } = await createMigrator(db).migrateTo("087_reference_field_relations");
		if (error) throw error;
		await new SchemaRegistry(db).createCollection({ slug: "legacy", label: "Legacy" });
		await sql`INSERT INTO ec_legacy (id, slug) VALUES ('legacy-entry', 'legacy')`.execute(db);
		const interrupted = db.withPlugin({
			transformQuery(args) {
				if (
					args.node.kind === "RawNode" &&
					args.node.sqlFragments.join("").includes("CREATE TRIGGER")
				) {
					throw new Error("interrupted before trigger installation");
				}
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		await expect(up(interrupted)).rejects.toThrow("interrupted before trigger installation");
		expect(await hasImportBaselineTriggers(db, "legacy")).toBe(false);
		await up(db);
		await sql`DROP TRIGGER emdash_import_legacy_seo_update`.execute(db);
		expect(await hasImportBaselineTriggers(db, "legacy")).toBe(false);
		await up(db);
		await up(db);
		expect(await hasImportBaselineTriggers(db, "legacy")).toBe(true);
		expect(await db.selectFrom("_emdash_import_baselines").selectAll().execute()).toEqual([]);
		const { rows } = await sql<{
			slug: string;
			version: number;
		}>`SELECT slug, version FROM ec_legacy WHERE id = 'legacy-entry'`.execute(db);
		expect(rows).toEqual([{ slug: "legacy", version: 1 }]);
	});

	it("installs past a registry row whose content table is already gone and leaves it unknown", async () => {
		const { error } = await createMigrator(db).migrateTo("087_reference_field_relations");
		if (error) throw error;
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "gone", label: "Gone" });
		await registry.createCollection({ slug: "kept", label: "Kept" });
		// An interrupted D1 delete drops the table before it removes the registry row.
		await sql`DROP TABLE ec_gone`.execute(db);
		await up(db);
		await up(db);
		expect(await hasImportBaselineTriggers(db, "kept")).toBe(true);
		expect(await hasImportBaselineTriggers(db, "gone")).toBe(false);
		const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master
			WHERE type = 'trigger' AND name LIKE 'emdash_import_gone_%'`.execute(db);
		expect(rows).toEqual([]);
		await sql`INSERT INTO _emdash_seo (collection, content_id, seo_no_index)
			VALUES ('kept', 'entry', 0)`.execute(db);
	});

	it("allows old-schema assignment writes without inventing a baseline", async () => {
		await expect(markImportBaselineCustomerOwned(db, "post", "entry")).resolves.toBeUndefined();
		expect(await hasImportBaselineTriggers(db, "post")).toBe(false);
	});

	it("exposes PostgreSQL as unavailable without executing SQLite SQL", async () => {
		const unsupported = new Kysely<Database>({
			dialect: new PostgresDialect({ pool: new Pool({ host: "invalid.example" }) }),
			plugins: [
				{
					transformQuery() {
						throw new Error("unsupported dialect must not query");
					},
					async transformResult(args) {
						return args.result;
					},
				},
			],
		});
		try {
			expect(supportsImportBaselineDialect(unsupported)).toBe(false);
			expect(await hasImportBaselineTriggers(unsupported, "post")).toBe(false);
		} finally {
			await unsupported.destroy();
		}
	});
});
