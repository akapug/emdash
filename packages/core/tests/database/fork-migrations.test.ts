import { sql, type Kysely } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/connection.js";
import { MIGRATION_LOCK_TABLE } from "../../src/database/migration-lock.js";
import * as fixFts5Triggers from "../../src/database/migrations/039_fix_fts5_triggers.js";
import {
	createMigrator,
	MIGRATION_NAMES,
	runMigrations,
} from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { migrationManifestV1Schema } from "../../src/migrations/manifest.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { FTSManager } from "../../src/search/fts-manager.js";

const UPSTREAM_NAME = /^\d{3}_[a-z0-9_]+$/;
const FORK_NAME = /^embark_\d{3}_[a-z0-9_]+$/;

/** An upstream migration released after the fork's own: its number sorts before `embark_`. */
const LATER_UPSTREAM: Migration = {
	async up(db) {
		await sql`CREATE TABLE later_upstream (id TEXT PRIMARY KEY)`.execute(db);
	},
};

async function registeredWithLaterUpstream(
	db: Kysely<Database>,
): Promise<Record<string, Migration>> {
	const registered = await createMigrator(db).getMigrations();
	return {
		...Object.fromEntries(registered.map((info) => [info.name, info.migration])),
		"090_later_upstream": LATER_UPSTREAM,
	};
}

async function ledger(db: Kysely<Database>): Promise<string[]> {
	const { rows } = await sql<{
		name: string;
	}>`SELECT name FROM _emdash_migrations ORDER BY name`.execute(db);
	return rows.map((row) => row.name);
}

/** Every FTS object for `posts`: the table, its shadow tables and its sync triggers. */
async function ftsSchema(db: Kysely<Database>): Promise<string[]> {
	const { rows } = await sql<{
		name: string;
		sql: string | null;
	}>`SELECT name, sql FROM sqlite_master
		WHERE name LIKE '%fts%posts%' ORDER BY name`.execute(db);
	return rows.map((row) => `${row.name}: ${row.sql ?? ""}`);
}

describe("fork migrations", () => {
	let db: Kysely<Database>;

	beforeEach(() => {
		db = createDatabase({ url: ":memory:" });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("names every migration either NNN_ (upstream) or embark_NNN_ (fork), and every fork one sorts after every upstream one", () => {
		const upstream = MIGRATION_NAMES.filter((name) => UPSTREAM_NAME.test(name));
		const fork = MIGRATION_NAMES.filter((name) => FORK_NAME.test(name));
		expect(upstream.length + fork.length).toBe(MIGRATION_NAMES.length);
		expect(fork).toEqual(["embark_001_import_baselines", "embark_002_import_sync_grants"]);
		const sorted = [...MIGRATION_NAMES].toSorted((a, b) => a.localeCompare(b));
		expect(sorted.slice(-fork.length)).toEqual(fork);
	});

	it("still applies an upstream migration that arrives after the fork's own have run", async () => {
		const { error } = await createMigrator(db).migrateToLatest();
		if (error) throw error;

		const migrations = await registeredWithLaterUpstream(db);
		const result = await createMigrator(db, { migrations }).migrateToLatest();
		if (result.error) throw result.error;
		expect(result.results?.map((r) => [r.migrationName, r.status])).toEqual([
			["090_later_upstream", "Success"],
		]);
		const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master
			WHERE type = 'table' AND name = 'later_upstream'`.execute(db);
		expect(rows).toHaveLength(1);
	});

	it("is refused by an ordered migrator on the same database (the control: the option is what admits it)", async () => {
		const { error } = await createMigrator(db).migrateToLatest();
		if (error) throw error;

		const migrations = await registeredWithLaterUpstream(db);
		const ordered = new Migrator({
			db,
			provider: { getMigrations: async () => migrations },
			migrationTableName: "_emdash_migrations",
			migrationLockTableName: MIGRATION_LOCK_TABLE,
		});
		const result = await ordered.migrateToLatest();
		expect(String(result.error)).toContain("corrupted migrations");
	});

	it("refuses a ledger missing an upstream migration before running anything, so 039 never undoes 064's index", async () => {
		await runMigrations(db);
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await new FTSManager(db).enableSearch("posts");
		const index = await ftsSchema(db);
		expect(index.length).toBeGreaterThan(1);
		// 064's self-contained table; 039 would rebuild it as external content.
		expect(index.join("\n")).not.toContain("content='ec_posts'");
		await sql`DELETE FROM _emdash_migrations WHERE name = '039_fix_fts5_triggers'`.execute(db);
		const recorded = await ledger(db);

		const refusal = runMigrations(db);
		await expect(refusal).rejects.toMatchObject({
			name: "MigrationLedgerOrderError",
			series: "upstream",
		});
		await expect(refusal).rejects.toThrow(
			"recorded 040_byline_i18n where 039_fix_fts5_triggers belongs",
		);
		expect(await ftsSchema(db)).toEqual(index);
		expect(await ledger(db)).toEqual(recorded);

		// The control: 039 run by hand is what the refusal kept out, and the witness sees it.
		await fixFts5Triggers.up(db);
		expect((await ftsSchema(db)).join("\n")).toContain("content='ec_posts'");
	});

	it("refuses a ledger missing embark_001 below a recorded embark_002", async () => {
		await runMigrations(db);
		await sql`DELETE FROM _emdash_migrations WHERE name = 'embark_001_import_baselines'`.execute(
			db,
		);
		const recorded = await ledger(db);

		const result = await createMigrator(db).migrateToLatest();
		expect(result.error).toMatchObject({ name: "MigrationLedgerOrderError", series: "fork" });
		expect(String(result.error)).toContain(
			"recorded embark_002_import_sync_grants where embark_001_import_baselines belongs",
		);
		expect(await ledger(db)).toEqual(recorded);
	});

	it("refuses a ledger whose series ran out of order, though every name below the pending one is recorded", async () => {
		await runMigrations(db);
		await sql`DELETE FROM _emdash_migrations WHERE name = '087_reference_field_relations'`.execute(
			db,
		);
		await sql`UPDATE _emdash_migrations SET timestamp = '2999-01-01T00:00:00.000Z'
			WHERE name = '039_fix_fts5_triggers'`.execute(db);
		const recorded = await ledger(db);

		const result = await createMigrator(db).migrateToLatest();
		expect(result.error).toMatchObject({ name: "MigrationLedgerOrderError", series: "upstream" });
		expect(String(result.error)).toContain(
			"recorded 040_byline_i18n where 039_fix_fts5_triggers belongs",
		);
		expect(await ledger(db)).toEqual(recorded);
	});

	it("is accepted by the build's migration manifest", () => {
		const parsed = migrationManifestV1Schema.shape.migrationSet.shape.names.safeParse([
			...MIGRATION_NAMES,
		]);
		expect(parsed.success).toBe(true);
		expect(
			migrationManifestV1Schema.shape.migrationSet.shape.names.safeParse(["embark_1_short"])
				.success,
		).toBe(false);
	});
});
