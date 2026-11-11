import { sql, type Kysely } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/connection.js";
import { MIGRATION_LOCK_TABLE } from "../../src/database/migration-lock.js";
import { createMigrator, MIGRATION_NAMES } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { migrationManifestV1Schema } from "../../src/migrations/manifest.js";

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
