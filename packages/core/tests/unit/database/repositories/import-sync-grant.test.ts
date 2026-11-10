import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { columnExists } from "../../../../src/database/dialect-helpers.js";
import { up } from "../../../../src/database/migrations/087_import_sync_grants.js";
import { createMigrator } from "../../../../src/database/migrations/runner.js";
import { ImportSyncGrantRepository } from "../../../../src/database/repositories/import-sync-grant.js";
import type { Database } from "../../../../src/database/types.js";
import { importSyncGrantCases } from "../../../utils/import-sync-grant-cases.js";
import {
	createTestDatabase,
	setupTestDatabase,
	teardownTestDatabase,
} from "../../../utils/test-db.js";

describe("import sync grants on SQLite", () => {
	let db: Kysely<Database>;
	beforeEach(async () => {
		db = await setupTestDatabase();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});
	importSyncGrantCases(() => db);
});

describe("import sync grant schema expansion", () => {
	let db: Kysely<Database>;
	beforeEach(() => {
		db = createTestDatabase();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it.each([1, 2, 3])(
		"restarts before operation column %i without changing completed legacy receipts",
		async (interruptedColumn) => {
			const { error } = await createMigrator(db).migrateTo("086_import_baselines");
			if (error) throw error;
			await sql`INSERT INTO _emdash_import_operations
			(operation_id, source_site, source_type, source_id, collection, entry_id, locale,
			sequence, request_hash, revision_id, version, completed)
			VALUES ('legacy', 'https://source.example', 'post', 'source-id', 'post', 'entry', 'en',
			1, 'request', 'original', 1, 1)`.execute(db);
			let columnAdditions = 0;
			const interrupted = db.withPlugin({
				transformQuery(args) {
					if (args.node.kind === "AlterTableNode" && ++columnAdditions === interruptedColumn) {
						throw new Error("interrupted during operation columns");
					}
					return args.node;
				},
				async transformResult(args) {
					return args.result;
				},
			});
			await expect(up(interrupted)).rejects.toThrow("interrupted during operation columns");
			expect(await columnExists(db, "_emdash_import_operations", "grant_id")).toBe(
				interruptedColumn > 1,
			);
			expect(await columnExists(db, "_emdash_import_operations", "grant_generation")).toBe(
				interruptedColumn > 2,
			);
			await up(db);
			await up(db);
			expect(
				await db
					.selectFrom("_emdash_import_operations")
					.select(["completed", "revision_id", "grant_id", "grant_generation", "binding_id"])
					.where("operation_id", "=", "legacy")
					.executeTakeFirst(),
			).toEqual({
				completed: 1,
				revision_id: "original",
				grant_id: null,
				grant_generation: null,
				binding_id: null,
			});
			const repository = new ImportSyncGrantRepository(db);
			const grant = await repository.create({
				sourceSite: "https://source.example",
				bindingId: "binding",
				actorId: "actor",
			});
			expect((await repository.revoke(grant.id))?.generation).toBe(grant.generation + 1);
		},
	);

	it("explicitly refuses unsupported dialects before querying", async () => {
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
		const repository = new ImportSyncGrantRepository(unsupported);
		try {
			await expect(
				repository.create({
					sourceSite: "https://source.example",
					bindingId: "binding",
					actorId: "actor",
				}),
			).rejects.toThrow("unavailable for this database dialect");
			await expect(repository.find("missing")).rejects.toThrow(
				"unavailable for this database dialect",
			);
			await expect(repository.revoke("missing")).rejects.toThrow(
				"unavailable for this database dialect",
			);
		} finally {
			await unsupported.destroy();
		}
	});
});
