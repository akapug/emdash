import { env } from "cloudflare:test";
import { Kysely, SqliteAdapter, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import {
	ImportSyncRepository,
	type ImportSyncApplied,
	type ImportSyncInput,
} from "../../src/database/repositories/import-sync.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;
let repo: ImportSyncRepository;
let batches: number;
let beforeBatch: (() => Promise<void>) | undefined;
let loseResponse: boolean;

function request(overrides: Partial<ImportSyncInput> = {}): ImportSyncInput {
	return {
		operationId: "create",
		source: { site: "https://wp.example", type: "page", id: "1" },
		collection: "sync_d1",
		locale: "en",
		sequence: 1,
		requestHash: "create-hash",
		grant: { id: "grant-1", bindingId: "binding-1", generation: 1 },
		mappedFields: Object.keys(overrides.data ?? { title: "Original" }),
		slug: "page",
		data: { title: "Original" },
		authorId: "importer",
		...overrides,
	};
}

function next(
	created: ImportSyncApplied,
	overrides: Partial<ImportSyncInput> = {},
): ImportSyncInput {
	return request({
		operationId: "update",
		sequence: 2,
		requestHash: "update-hash",
		entryId: created.entryId,
		expectedVersion: created.version,
		data: { title: "Next" },
		...overrides,
	});
}

function requireApplied(
	result: Awaited<ReturnType<ImportSyncRepository["apply"]>>,
): ImportSyncApplied {
	expect(result.state).toBe("applied");
	if (result.state !== "applied") throw new Error(`Import refused: ${result.reason}`);
	return result;
}

async function snapshot() {
	const results = await Promise.all([
		sql`SELECT * FROM ec_sync_d1 ORDER BY id`.execute(db),
		sql`SELECT * FROM revisions ORDER BY id`.execute(db),
		sql`SELECT * FROM _emdash_import_baselines ORDER BY source_site, source_type, source_id, locale`.execute(
			db,
		),
		sql`SELECT * FROM _emdash_import_operations ORDER BY operation_id`.execute(db),
		sql`SELECT * FROM _emdash_import_grants ORDER BY id`.execute(db),
		sql`SELECT * FROM _emdash_revision_prune_queue ORDER BY collection, entry_id`.execute(db),
		sql`SELECT * FROM _emdash_seo ORDER BY collection, content_id`.execute(db),
	]);
	return results.map((result) => result.rows);
}

beforeAll(() => {
	const counted = new Proxy(env.DB, {
		get(target, property) {
			if (property === "batch")
				return async (statements: D1PreparedStatement[]) => {
					batches++;
					const before = beforeBatch;
					beforeBatch = undefined;
					await before?.();
					const results = await target.batch(statements);
					if (loseResponse) {
						loseResponse = false;
						throw new Error("lost response after D1 commit");
					}
					// Results, not cumulative affected-row counters, identify this operation.
					return results.map((result) => ({ ...result, meta: { ...result.meta, changes: 999 } }));
				};
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: counted }) });
	repo = new ImportSyncRepository(db);
});

beforeEach(async () => {
	beforeBatch = undefined;
	loseResponse = false;
	await resetD1Schema(db);
	await runMigrations(db);
	await sql`INSERT INTO _emdash_import_grants (id, source_site, binding_id, actor_id, generation, revoked)
		VALUES ('grant-1', 'https://wp.example', 'binding-1', 'importer', 1, 0)`.execute(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "sync_d1", label: "Import sync" });
	await registry.createField("sync_d1", { slug: "title", label: "Title", type: "string" });
	batches = 0;
});

afterAll(async () => {
	await db.destroy();
});

describe("provenance import on real D1 atomic batches", () => {
	it("refuses a D1 driver without an atomic adapter instead of falling back to sequential writes", async () => {
		class UnprovenD1Dialect extends RawBindingD1Dialect {
			override createAdapter(): SqliteAdapter {
				return new SqliteAdapter();
			}
		}
		const unproven = new Kysely<Database>({ dialect: new UnprovenD1Dialect({ database: env.DB }) });
		try {
			const unsupported = new ImportSyncRepository(unproven);
			expect(await unsupported.supports("sync_d1")).toBe(false);
			const before = await snapshot();
			expect((await unsupported.apply(request())).state).toBe("unknown");
			expect(await snapshot()).toEqual(before);
		} finally {
			await unproven.destroy();
		}
	});

	it("preserves unmapped custom columns and snapshots the complete current row inside the batch", async () => {
		await sql`ALTER TABLE ec_sync_d1 ADD COLUMN custom_note TEXT DEFAULT 'Retain custom'`.execute(
			db,
		);
		await sql`ALTER TABLE ec_sync_d1 ADD COLUMN custom_json TEXT DEFAULT '[{"kept":true}]'`.execute(
			db,
		);
		const created = requireApplied(await repo.apply(request()));
		await sql`CREATE TRIGGER reject_unmapped_write BEFORE UPDATE OF custom_note, custom_json ON ec_sync_d1
			BEGIN SELECT RAISE(ABORT, 'unmapped field was written'); END`.execute(db);
		const updated = requireApplied(
			await repo.apply(next(created, { data: { title: "Mapped only" }, mappedFields: ["title"] })),
		);
		expect(
			(
				await sql`SELECT title, custom_note, custom_json FROM ec_sync_d1 WHERE id = ${created.entryId} AND locale = 'en'`.execute(
					db,
				)
			).rows[0],
		).toMatchObject({
			title: "Mapped only",
			custom_note: "Retain custom",
			custom_json: '[{"kept":true}]',
		});
		const revision = await sql<{
			data: string;
		}>`SELECT data FROM revisions WHERE id = ${updated.revisionId}`.execute(db);
		expect(JSON.parse(revision.rows[0].data)).toEqual({
			title: "Mapped only",
			custom_note: "Retain custom",
			custom_json: '[{"kept":true}]',
			_slug: "page",
		});
	});

	it("retains literal-text, boolean and list snapshot types while only a mapped title changes", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createField("sync_d1", { slug: "literal_text", label: "Literal", type: "text" });
		await registry.createField("sync_d1", { slug: "enabled", label: "Enabled", type: "boolean" });
		await registry.createField("sync_d1", {
			slug: "choices",
			label: "Choices",
			type: "multiSelect",
		});
		const original = {
			title: "Original",
			literal_text: '{"note":"literal text"}',
			enabled: true,
			choices: ["one", "two"],
		};
		const created = requireApplied(await repo.apply(request({ data: original })));
		const changed = requireApplied(
			await repo.apply(next(created, { data: { title: "Mapped" }, mappedFields: ["title"] })),
		);
		const revision = await sql<{
			data: string;
		}>`SELECT data FROM revisions WHERE id = ${changed.revisionId}`.execute(db);
		expect(JSON.parse(revision.rows[0].data)).toEqual({
			...original,
			title: "Mapped",
			_slug: "page",
		});
	});

	it("rejects creation if the grant is revoked after preflight but before D1 applies", async () => {
		let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
		beforeBatch = async () => {
			await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(db);
			raced = await snapshot();
		};
		expect((await repo.apply(request())).state).not.toBe("applied");
		expect(await snapshot()).toEqual(raced);
	});

	it("empty mappings preserve every data column and still capture the current full snapshot", async () => {
		const created = requireApplied(await repo.apply(request()));
		await sql`CREATE TRIGGER reject_data_write BEFORE UPDATE OF title ON ec_sync_d1
			BEGIN SELECT RAISE(ABORT, 'empty mapping wrote data'); END`.execute(db);
		const changed = requireApplied(await repo.apply(next(created, { data: {}, mappedFields: [] })));
		const revision = await sql<{
			data: string;
		}>`SELECT data FROM revisions WHERE id = ${changed.revisionId}`.execute(db);
		expect(JSON.parse(revision.rows[0].data)).toEqual({ title: "Original", _slug: "page" });
	});

	it.each([
		{ grant: { id: "absent", bindingId: "binding-1", generation: 1 } },
		{ grant: { id: "grant-1", bindingId: "wrong-binding", generation: 1 } },
		{ grant: { id: "grant-1", bindingId: "binding-1", generation: 2 } },
		{ authorId: "wrong-actor" },
		{ source: { site: "https://wrong.example", type: "page" as const, id: "1" } },
	])("requires exact active grant authority for creation and updates: %j", async (overrides) => {
		let before = await snapshot();
		expect((await repo.apply(request(overrides))).state).not.toBe("applied");
		expect(await snapshot()).toEqual(before);
		const created = requireApplied(await repo.apply(request()));
		before = await snapshot();
		expect((await repo.apply(next(created, overrides))).state).not.toBe("applied");
		expect(await snapshot()).toEqual(before);
	});

	it.each(["revoke", "generation"])(
		"rejects grant %s between preflight and real D1 batch without import writes",
		async (kind) => {
			const created = requireApplied(await repo.apply(request()));
			let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
			beforeBatch = async () => {
				if (kind === "revoke")
					await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(db);
				else
					await sql`UPDATE _emdash_import_grants SET generation = generation + 1 WHERE id = 'grant-1'`.execute(
						db,
					);
				raced = await snapshot();
			};
			expect((await repo.apply(next(created))).state).not.toBe("applied");
			expect(await snapshot()).toEqual(raced);
			expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
			expect(await repo.lookup("create", request())).toEqual({ ...created, replayed: true });
		},
	);

	it("binds completed replay to its recorded grant without consulting current revocation", async () => {
		const created = requireApplied(await repo.apply(request()));
		await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(db);
		const before = await snapshot();
		expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
		for (const grant of [
			{ id: "other", bindingId: "binding-1", generation: 1 },
			{ id: "grant-1", bindingId: "other", generation: 1 },
			{ id: "grant-1", bindingId: "binding-1", generation: 2 },
		]) {
			// oxlint-disable-next-line no-await-in-loop -- each request probes a distinct replay identity
			expect(await repo.lookup("create", request({ grant }))).toMatchObject({ state: "conflict" });
		}
		expect(await snapshot()).toEqual(before);
	});

	it("pre-fence completed operations remain applied after grant revocation, but no new apply bypasses grant", async () => {
		const created = requireApplied(await repo.apply(request()));
		await sql`UPDATE _emdash_import_operations SET grant_id = NULL, grant_generation = NULL, binding_id = NULL`.execute(
			db,
		);
		await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(db);
		const before = await snapshot();
		expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
		expect((await repo.apply(next(created))).state).not.toBe("applied");
		expect(await snapshot()).toEqual(before);
	});

	it("atomically creates and updates its own revision, retaining the original and durable replay", async () => {
		const created = requireApplied(await repo.apply(request()));
		const updated = requireApplied(await repo.apply(next(created)));
		expect(batches).toBe(2);
		expect(updated).toMatchObject({
			version: 2,
			originalRevisionId: created.revisionId,
			replayed: false,
		});
		expect(updated.revisionId).not.toBe(created.revisionId);
		expect((await sql`SELECT * FROM ec_sync_d1`.execute(db)).rows[0]).toMatchObject({
			title: "Next",
			live_revision_id: updated.revisionId,
			version: 2,
			draft_revision_id: null,
		});
		expect((await sql`SELECT id FROM revisions`.execute(db)).rows).toHaveLength(2);
		const before = await snapshot();
		expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
		expect(await repo.lookup("create", request({ requestHash: "wrong" }))).toMatchObject({
			state: "conflict",
		});
		expect(await snapshot()).toEqual(before);
	});

	it("recovers a lost committed D1 response from the durable receipt without another write", async () => {
		loseResponse = true;
		await expect(repo.apply(request())).rejects.toThrow("lost response after D1 commit");
		const before = await snapshot();
		const replayed = requireApplied(await repo.apply(request()));
		expect(replayed.replayed).toBe(true);
		expect(batches).toBe(1);
		expect(await snapshot()).toEqual(before);
	});

	it.each(["missing", "replaced"])(
		"refuses creation if its sticky trigger becomes %s between preflight and batch",
		async (kind) => {
			let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
			beforeBatch = async () => {
				await sql`DROP TRIGGER emdash_import_sync_d1_content_update`.execute(db);
				if (kind === "replaced") {
					await sql`CREATE TRIGGER emdash_import_sync_d1_content_update AFTER UPDATE ON ec_sync_d1 BEGIN SELECT 1; END`.execute(
						db,
					);
				}
				raced = await snapshot();
			};
			expect((await repo.apply(request())).state).not.toBe("applied");
			expect(await snapshot()).toEqual(raced);
		},
	);

	it("same-version races append one winning revision and no losing operation", async () => {
		const created = requireApplied(await repo.apply(request()));
		const results = await Promise.all([
			repo.apply(next(created)),
			repo.apply(next(created, { operationId: "other", sequence: 3, requestHash: "other" })),
		]);
		expect(results.filter((result) => result.state === "applied")).toHaveLength(1);
		expect(results.filter((result) => result.state === "conflict")).toHaveLength(1);
		expect((await sql`SELECT id FROM revisions`.execute(db)).rows).toHaveLength(2);
		expect(
			(await sql`SELECT operation_id FROM _emdash_import_operations`.execute(db)).rows,
		).toHaveLength(2);
		expect(
			(await sql`SELECT * FROM _emdash_import_operations WHERE completed = 0`.execute(db)).rows,
		).toHaveLength(0);
	});

	it("duplicate racing creates share one durable operation result", async () => {
		const results = (await Promise.all([repo.apply(request()), repo.apply(request())])).map(
			requireApplied,
		);
		expect(results[0]!.revisionId).toBe(results[1]!.revisionId);
		expect(
			results.map((result) => result.replayed).toSorted((a, b) => Number(a) - Number(b)),
		).toEqual([false, true]);
		expect((await sql`SELECT id FROM revisions`.execute(db)).rows).toHaveLength(1);
	});

	it.each(["same-byte content", "separate SEO"])(
		"never replaces after customer %s edits",
		async (kind) => {
			const created = requireApplied(await repo.apply(request()));
			if (kind === "separate SEO")
				await new SeoRepository(db).upsert("sync_d1", created.entryId, {
					title: "Customer metadata",
				});
			else
				await sql`UPDATE ec_sync_d1 SET title = title WHERE id = ${created.entryId} AND locale = 'en'`.execute(
					db,
				);
			const before = await snapshot();
			expect(await repo.apply(next(created))).toMatchObject({ state: "conflict" });
			expect(await snapshot()).toEqual(before);
		},
	);

	it("refuses missing source evidence, wrong locale and older accepted source order without any writes", async () => {
		const created = requireApplied(await repo.apply(request()));
		const before = await snapshot();
		expect(
			await repo.apply(
				next(created, { source: { site: "https://wrong.example", type: "page", id: "1" } }),
			),
		).toMatchObject({ state: "unknown" });
		expect(await repo.apply(next(created, { locale: "fr" }))).toMatchObject({ state: "unknown" });
		expect(await repo.apply(next(created, { sequence: 1 }))).toMatchObject({ state: "conflict" });
		expect(await snapshot()).toEqual(before);
	});

	for (const operation of ["create", "update"] as const) {
		for (const failure of ["abort", "ignore"] as const) {
			it.each(["revision", "content", "baseline", "prune", "complete"] as const)(
				`${operation} batch rolls back all effects when %s ${failure}s`,
				async (step) => {
					const created =
						operation === "update" ? requireApplied(await repo.apply(request())) : undefined;
					const target =
						step === "revision"
							? "revisions"
							: step === "content"
								? "ec_sync_d1"
								: step === "baseline"
									? "_emdash_import_baselines"
									: step === "prune"
										? "_emdash_revision_prune_queue"
										: "_emdash_import_operations";
					const action =
						step === "complete" ||
						(operation === "update" && ["content", "baseline", "prune"].includes(step))
							? sql`UPDATE`
							: sql`INSERT`;
					const raise =
						failure === "ignore" ? sql`RAISE(IGNORE)` : sql`RAISE(ABORT, 'injected failure')`;
					await sql`CREATE TRIGGER inject_import_failure BEFORE ${action} ON ${sql.ref(target)} BEGIN SELECT ${raise}; END`.execute(
						db,
					);
					const before = await snapshot();
					await expect(repo.apply(created ? next(created) : request())).rejects.toThrow();
					expect(await snapshot()).toEqual(before);
				},
			);
		}
	}
});
