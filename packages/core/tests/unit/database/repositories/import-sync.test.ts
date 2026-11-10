import type { CompiledQuery, Kysely, QueryResult } from "kysely";
import { SqliteAdapter, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import {
	ImportSyncRepository,
	supportsAtomicImportSync,
	type ImportSyncApplied,
	type ImportSyncInput,
} from "../../../../src/database/repositories/import-sync.js";
import { SeoRepository } from "../../../../src/database/repositories/seo.js";
import type { Database } from "../../../../src/database/types.js";
import { SchemaRegistry } from "../../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

function request(overrides: Partial<ImportSyncInput> = {}): ImportSyncInput {
	return {
		operationId: "create-1",
		source: { site: "https://source.example", type: "page", id: "17" },
		collection: "page",
		locale: "en",
		sequence: 1,
		requestHash: "accepted-create-hash",
		grant: {
			id: overrides.source?.site === "https://other.example" ? "grant-other" : "grant-1",
			bindingId: "binding-1",
			generation: 1,
		},
		mappedFields: Object.keys(overrides.data ?? { title: "Original", content: [] }),
		slug: "original",
		data: { title: "Original", content: [] },
		authorId: "importer",
		...overrides,
	};
}

function update(
	created: ImportSyncApplied,
	overrides: Partial<ImportSyncInput> = {},
): ImportSyncInput {
	return request({
		operationId: "update-2",
		sequence: 2,
		requestHash: "accepted-update-hash",
		entryId: created.entryId,
		expectedVersion: created.version,
		data: { title: "Updated", content: [] },
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

async function snapshot(db: Kysely<Database>) {
	return Promise.all([
		sql`SELECT * FROM ec_page ORDER BY id`.execute(db),
		sql`SELECT * FROM ec_post ORDER BY id`.execute(db),
		sql`SELECT * FROM revisions ORDER BY id`.execute(db),
		sql`SELECT * FROM _emdash_seo ORDER BY collection, content_id`.execute(db),
		sql`SELECT * FROM _emdash_import_baselines ORDER BY source_site, source_type, source_id, locale`.execute(
			db,
		),
		sql`SELECT * FROM _emdash_import_operations ORDER BY operation_id`.execute(db),
		sql`SELECT * FROM _emdash_import_grants ORDER BY id`.execute(db),
		sql`SELECT * FROM _emdash_revision_prune_queue ORDER BY collection, entry_id`.execute(db),
	]).then((results) => results.map((result) => result.rows));
}

for (const mode of ["sqlite transaction", "D1-style atomic adapter"] as const) {
	describe(`ImportSyncRepository using ${mode}`, () => {
		let db: Kysely<Database>;
		let repo: ImportSyncRepository;
		let batches: number;
		let beforeBatch: (() => Promise<void>) | undefined;
		let afterBatch: (() => Promise<void>) | undefined;

		beforeEach(async () => {
			db = await setupTestDatabaseWithCollections();
			await sql`INSERT INTO _emdash_import_grants (id, source_site, binding_id, actor_id, generation, revoked)
				VALUES ('grant-1', 'https://source.example', 'binding-1', 'importer', 1, 0),
				('grant-other', 'https://other.example', 'binding-1', 'importer', 1, 0)`.execute(db);
			batches = 0;
			beforeBatch = undefined;
			afterBatch = undefined;
			if (mode === "D1-style atomic adapter") {
				Object.assign(db.getExecutor().adapter, {
					async executeAtomicBatch(queries: readonly CompiledQuery[]) {
						batches++;
						const before = beforeBatch;
						beforeBatch = undefined;
						await before?.();
						const result = await db.transaction().execute(async (trx) => {
							const results: QueryResult<unknown>[] = [];
							for (const query of queries) {
								// oxlint-disable-next-line no-await-in-loop -- emulate D1's ordered atomic batch on real SQLite
								results.push(await trx.executeQuery(query));
							}
							return results;
						});
						const after = afterBatch;
						afterBatch = undefined;
						await after?.();
						return result;
					},
				});
			}
			repo = new ImportSyncRepository(db);
		});

		afterEach(async () => {
			await teardownTestDatabase(db);
		});

		it.each(["table", "operation_column"])(
			"refuses new applies with incomplete grant schema: %s",
			async (kind) => {
				expect(await repo.supports("page")).toBe(true);
				if (kind === "table") await sql`DROP TABLE _emdash_import_grants`.execute(db);
				else
					await sql`ALTER TABLE _emdash_import_operations DROP COLUMN grant_generation`.execute(db);
				expect(await repo.supports("page")).toBe(false);
				expect(await repo.apply(request())).toEqual({
					state: "unknown",
					reason: "import_provenance_unavailable",
				});
				expect((await sql`SELECT * FROM ec_page`.execute(db)).rows).toHaveLength(0);
				expect((await sql`SELECT * FROM revisions`.execute(db)).rows).toHaveLength(0);
				expect((await sql`SELECT * FROM _emdash_import_operations`.execute(db)).rows).toHaveLength(
					0,
				);
			},
		);

		it.each(["missing", "replaced"])(
			"refuses direct apply when its sticky content trigger is %s",
			async (kind) => {
				expect(await repo.supports("page")).toBe(true);
				await sql`DROP TRIGGER emdash_import_page_content_update`.execute(db);
				if (kind === "replaced") {
					await sql`CREATE TRIGGER emdash_import_page_content_update AFTER UPDATE ON ec_page BEGIN SELECT 1; END`.execute(
						db,
					);
				}
				expect(await repo.supports("page")).toBe(false);
				expect(await repo.supports()).toBe(false);
				const before = await snapshot(db);
				expect(await repo.apply(request())).toEqual({
					state: "unknown",
					reason: "import_provenance_unavailable",
				});
				expect(await snapshot(db)).toEqual(before);
			},
		);

		it("creates content, original live revision, provenance and durable receipt together", async () => {
			const created = requireApplied(await repo.apply(request({ entryId: "producer-id" })));
			expect(created).toMatchObject({ entryId: "producer-id", version: 1, replayed: false });
			expect(created.originalRevisionId).toBe(created.revisionId);
			expect(await repo.lookup("create-1", request({ entryId: "producer-id" }))).toEqual({
				...created,
				replayed: true,
			});
			const content = await sql<
				Record<string, unknown>
			>`SELECT * FROM ec_page WHERE id = ${created.entryId} AND locale = 'en'`.execute(db);
			expect(content.rows[0]).toMatchObject({
				title: "Original",
				status: "published",
				version: 1,
				live_revision_id: created.revisionId,
				draft_revision_id: null,
				locale: "en",
			});
			const baseline = await sql`SELECT * FROM _emdash_import_baselines`.execute(db);
			expect(baseline.rows[0]).toMatchObject({
				original_revision_id: created.revisionId,
				customer_owned: 0,
				last_operation_id: "create-1",
				last_sequence: 1,
			});
			if (mode === "D1-style atomic adapter") expect(batches).toBe(1);
		});

		it.each([true, false])(
			"preserves unmapped custom columns without writing them (snapshot includes custom: %s)",
			async (includeCustom) => {
				await sql`ALTER TABLE ec_page ADD COLUMN custom_note TEXT DEFAULT 'Keep me'`.execute(db);
				const created = requireApplied(await repo.apply(request()));
				await sql`CREATE TRIGGER reject_unmapped_write BEFORE UPDATE OF custom_note, content ON ec_page
				BEGIN SELECT RAISE(ABORT, 'unmapped field was written'); END`.execute(db);
				const data = {
					title: "Mapped update",
					content: [],
					...(includeCustom ? { custom_note: "Must not overwrite" } : {}),
				};
				const changed = requireApplied(
					await repo.apply(update(created, { data, mappedFields: ["title"] })),
				);
				expect(
					(
						await sql`SELECT title, content, custom_note FROM ec_page WHERE id = ${created.entryId} AND locale = 'en'`.execute(
							db,
						)
					).rows[0],
				).toMatchObject({ title: "Mapped update", content: "[]", custom_note: "Keep me" });
				const revision = await sql<{
					data: string;
				}>`SELECT data FROM revisions WHERE id = ${changed.revisionId}`.execute(db);
				expect(JSON.parse(revision.rows[0].data)).toEqual({
					title: "Mapped update",
					content: [],
					custom_note: "Keep me",
					_slug: "original",
				});
			},
		);

		it("preserves literal JSON-looking text, booleans and lists in the complete revision snapshot", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createField("page", { slug: "literal_text", label: "Literal", type: "text" });
			await registry.createField("page", { slug: "enabled", label: "Enabled", type: "boolean" });
			await registry.createField("page", {
				slug: "choices",
				label: "Choices",
				type: "multiSelect",
			});
			const original = {
				title: "Original",
				content: [],
				literal_text: '{"note":"literal text"}',
				enabled: true,
				choices: ["one", "two"],
			};
			const created = requireApplied(await repo.apply(request({ data: original })));
			const changed = requireApplied(
				await repo.apply(update(created, { data: { title: "Mapped" }, mappedFields: ["title"] })),
			);
			const revision = await sql<{
				data: string;
			}>`SELECT data FROM revisions WHERE id = ${changed.revisionId}`.execute(db);
			expect(JSON.parse(revision.rows[0].data)).toEqual({
				...original,
				title: "Mapped",
				_slug: "original",
			});
		});

		it("an empty mapping appends the complete snapshot without writing any data columns", async () => {
			const created = requireApplied(await repo.apply(request()));
			await sql`CREATE TRIGGER reject_data_write BEFORE UPDATE OF title, content ON ec_page
				BEGIN SELECT RAISE(ABORT, 'empty mapping wrote data'); END`.execute(db);
			const changed = requireApplied(
				await repo.apply(update(created, { data: {}, mappedFields: [] })),
			);
			expect(changed.version).toBe(2);
			expect(
				(
					await sql`SELECT title FROM ec_page WHERE id = ${created.entryId} AND locale = 'en'`.execute(
						db,
					)
				).rows[0],
			).toMatchObject({ title: "Original" });
		});

		it.each([
			{ mappedFields: ["title", "title"] },
			{ mappedFields: ["missing"] },
			{ mappedFields: ["version"] },
			{ mappedFields: ["title; DROP TABLE revisions"] },
		])("refuses invalid mapped fields %j with zero effects", async ({ mappedFields }) => {
			const before = await snapshot(db);
			const outcome = await repo.apply(request({ mappedFields })).catch(() => null);
			expect(outcome?.state).not.toBe("applied");
			expect(await snapshot(db)).toEqual(before);
		});

		it.each([
			{ grant: { id: "absent", bindingId: "binding-1", generation: 1 } },
			{ grant: { id: "grant-1", bindingId: "wrong-binding", generation: 1 } },
			{ grant: { id: "grant-1", bindingId: "binding-1", generation: 2 } },
			{ authorId: "wrong-actor" },
			{ source: { site: "https://wrong.example", type: "page" as const, id: "17" } },
		])("requires the exact active grant authority on create and update: %j", async (overrides) => {
			let before = await snapshot(db);
			expect((await repo.apply(request(overrides))).state).not.toBe("applied");
			expect(await snapshot(db)).toEqual(before);
			const created = requireApplied(await repo.apply(request()));
			before = await snapshot(db);
			expect((await repo.apply(update(created, overrides))).state).not.toBe("applied");
			expect(await snapshot(db)).toEqual(before);
		});

		it("persists grant identity and replays completed outcomes after revocation without new writes", async () => {
			const created = requireApplied(await repo.apply(request()));
			expect(
				(
					await sql`SELECT grant_id, grant_generation, binding_id FROM _emdash_import_operations`.execute(
						db,
					)
				).rows[0],
			).toEqual({ grant_id: "grant-1", grant_generation: 1, binding_id: "binding-1" });
			await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(db);
			const before = await snapshot(db);
			expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
			expect(await repo.lookup("create-1", request())).toEqual({ ...created, replayed: true });
			expect((await repo.apply(update(created))).state).not.toBe("applied");
			expect(await snapshot(db)).toEqual(before);
		});

		it("keeps pre-fence nullable-grant completed receipts replayable without enrolling a new operation", async () => {
			const created = requireApplied(await repo.apply(request()));
			await sql`UPDATE _emdash_import_operations SET grant_id = NULL, grant_generation = NULL, binding_id = NULL`.execute(
				db,
			);
			await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(db);
			const before = await snapshot(db);
			expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
			expect((await repo.apply(update(created))).state).not.toBe("applied");
			expect(await snapshot(db)).toEqual(before);
		});

		it("promotes only its own immutable revision and keeps the original snapshot", async () => {
			const created = requireApplied(await repo.apply(request()));
			const changed = requireApplied(await repo.apply(update(created)));
			expect(changed).toMatchObject({
				entryId: created.entryId,
				version: 2,
				originalRevisionId: created.revisionId,
				replayed: false,
			});
			expect(changed.revisionId).not.toBe(created.revisionId);
			const revisions = await sql<{
				id: string;
				data: string;
			}>`SELECT id, data FROM revisions ORDER BY id`.execute(db);
			expect(revisions.rows).toHaveLength(2);
			expect(JSON.parse(revisions.rows.find((row) => row.id === created.revisionId)!.data)).toEqual(
				{ title: "Original", content: [], _slug: "original" },
			);
			expect(JSON.parse(revisions.rows.find((row) => row.id === changed.revisionId)!.data)).toEqual(
				{ title: "Updated", content: [], _slug: "original" },
			);
			expect((await sql`SELECT * FROM ec_page`.execute(db)).rows[0]).toMatchObject({
				title: "Updated",
				version: 2,
				live_revision_id: changed.revisionId,
				draft_revision_id: null,
			});
			expect((await sql`SELECT * FROM _emdash_import_baselines`.execute(db)).rows[0]).toMatchObject(
				{
					version: 2,
					customer_owned: 0,
					live_revision_id: changed.revisionId,
					original_revision_id: created.revisionId,
				},
			);
		});

		it("returns an old operation's own receipt after later source and customer saves without rewinding", async () => {
			const created = requireApplied(await repo.apply(request()));
			await repo.apply(update(created));
			await sql`UPDATE ec_page SET title = 'Customer' WHERE id = ${created.entryId} AND locale = 'en'`.execute(
				db,
			);
			const before = await snapshot(db);
			expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
			expect(await repo.lookup("create-1")).toEqual({ ...created, replayed: true });
			expect(await snapshot(db)).toEqual(before);
		});

		it("concurrent duplicate operations produce one revision and one replay", async () => {
			const results = await Promise.all([repo.apply(request()), repo.apply(request())]);
			const applied = results.map(requireApplied);
			expect(applied[0]!.revisionId).toBe(applied[1]!.revisionId);
			expect(
				applied.map((result) => result.replayed).toSorted((a, b) => Number(a) - Number(b)),
			).toEqual([false, true]);
			expect((await sql`SELECT id FROM revisions`.execute(db)).rows).toHaveLength(1);
			expect(
				(await sql`SELECT operation_id FROM _emdash_import_operations`.execute(db)).rows,
			).toHaveLength(1);
		});

		it.each([
			{ requestHash: "different-hash" },
			{ source: { site: "https://other.example", type: "page" as const, id: "17" } },
			{ source: { site: "https://source.example", type: "post" as const, id: "17" } },
			{ source: { site: "https://source.example", type: "page" as const, id: "18" } },
			{ locale: "fr" },
			{ sequence: 2 },
			{ collection: "post" },
			{ entryId: "another-id" },
			{ grant: { id: "another-grant", bindingId: "binding-1", generation: 1 } },
			{ grant: { id: "grant-1", bindingId: "another-binding", generation: 1 } },
			{ grant: { id: "grant-1", bindingId: "binding-1", generation: 2 } },
		])("refuses operation-id reuse with a different accepted identity: %j", async (overrides) => {
			await repo.apply(request());
			const before = await snapshot(db);
			expect(await repo.lookup("create-1", request(overrides))).toMatchObject({
				state: "conflict",
				reason: "operation_identity_mismatch",
			});
			expect(await repo.apply(request(overrides))).toMatchObject({ state: "conflict" });
			expect(await snapshot(db)).toEqual(before);
		});

		it("allows one same-version race winner and leaves no loser operation or audit", async () => {
			const created = requireApplied(await repo.apply(request()));
			const results = await Promise.all([
				repo.apply(update(created)),
				repo.apply(
					update(created, {
						operationId: "update-3",
						sequence: 3,
						requestHash: "third",
						data: { title: "Third", content: [] },
					}),
				),
			]);
			expect(results.filter((result) => result.state === "applied")).toHaveLength(1);
			expect(results.filter((result) => result.state === "conflict")).toHaveLength(1);
			expect((await sql`SELECT id FROM revisions`.execute(db)).rows).toHaveLength(2);
			expect(
				(await sql`SELECT * FROM _emdash_import_operations WHERE completed = 0`.execute(db)).rows,
			).toHaveLength(0);
			expect(
				(await sql`SELECT operation_id FROM _emdash_import_operations`.execute(db)).rows,
			).toHaveLength(2);
		});

		it("requires the exact prior producer revision and receipt, not just a matching row version", async () => {
			const created = requireApplied(await repo.apply(request()));
			const changed = requireApplied(await repo.apply(update(created)));
			await sql`UPDATE _emdash_import_baselines SET live_revision_id = ${created.revisionId}`.execute(
				db,
			);
			const before = await snapshot(db);
			expect(
				await repo.apply(update(changed, { operationId: "bad-baseline", sequence: 3 })),
			).toMatchObject({ state: "conflict" });
			expect(await snapshot(db)).toEqual(before);
		});

		it("refuses stale expected versions and out-of-order accepted source sequences with zero effects", async () => {
			const created = requireApplied(await repo.apply(request()));
			const changed = requireApplied(await repo.apply(update(created, { sequence: 3 })));
			const before = await snapshot(db);
			expect(
				await repo.apply(update(created, { operationId: "stale", sequence: 4 })),
			).toMatchObject({ state: "conflict" });
			expect(
				await repo.apply(update(changed, { operationId: "reordered", sequence: 2 })),
			).toMatchObject({ state: "conflict" });
			expect(await snapshot(db)).toEqual(before);
		});

		it.each([
			{ source: { site: "https://other.example", type: "page" as const, id: "17" } },
			{ source: { site: "https://source.example", type: "post" as const, id: "17" } },
			{ source: { site: "https://source.example", type: "page" as const, id: "18" } },
			{ locale: "fr" },
			{ collection: "post" },
			{ entryId: "another-entry" },
		])("cannot target another source, collection, row or locale: %j", async (overrides) => {
			const created = requireApplied(await repo.apply(request()));
			const before = await snapshot(db);
			expect((await repo.apply(update(created, overrides))).state).not.toBe("applied");
			expect(await snapshot(db)).toEqual(before);
		});

		it("isolates the same source id and slug by site, type and locale", async () => {
			const english = requireApplied(await repo.apply(request()));
			const french = requireApplied(await repo.apply(request({ operationId: "fr", locale: "fr" })));
			const otherSite = requireApplied(
				await repo.apply(
					request({
						operationId: "site",
						source: { site: "https://other.example", type: "page", id: "17" },
						slug: "other-site",
					}),
				),
			);
			const post = requireApplied(
				await repo.apply(
					request({
						operationId: "post",
						source: { site: "https://source.example", type: "post", id: "17" },
						collection: "post",
					}),
				),
			);
			expect(new Set([english.entryId, french.entryId, otherSite.entryId, post.entryId]).size).toBe(
				4,
			);
			await repo.apply(
				update(french, {
					operationId: "fr-update",
					locale: "fr",
					data: { title: "Français", content: [] },
				}),
			);
			expect(
				(
					await sql`SELECT title FROM ec_page WHERE id = ${english.entryId} AND locale = 'en'`.execute(
						db,
					)
				).rows[0],
			).toMatchObject({ title: "Original" });
		});

		it("never adopts a colliding slug or legacy row without producer evidence", async () => {
			const legacy = await new ContentRepository(db).create({
				type: "page",
				slug: "original",
				locale: "en",
				data: { title: "Legacy" },
			});
			const before = await snapshot(db);
			expect(await repo.apply(request())).toMatchObject({ state: "conflict" });
			expect(
				await repo.apply(request({ entryId: legacy.id, expectedVersion: legacy.version })),
			).toMatchObject({ state: "unknown" });
			expect(await snapshot(db)).toEqual(before);
		});

		it.each(["same-byte", "change-and-revert", "delete"])(
			"customer %s writes stay sticky",
			async (kind) => {
				const created = requireApplied(await repo.apply(request()));
				if (kind === "delete") {
					await sql`DELETE FROM ec_page WHERE id = ${created.entryId} AND locale = 'en'`.execute(
						db,
					);
				} else {
					if (kind === "change-and-revert")
						await sql`UPDATE ec_page SET title = 'Customer' WHERE id = ${created.entryId} AND locale = 'en'`.execute(
							db,
						);
					await sql`UPDATE ec_page SET title = 'Original' WHERE id = ${created.entryId} AND locale = 'en'`.execute(
						db,
					);
				}
				const before = await snapshot(db);
				expect(await repo.apply(update(created))).toMatchObject({ state: "conflict" });
				expect(await snapshot(db)).toEqual(before);
				expect(
					(await sql`SELECT customer_owned FROM _emdash_import_baselines`.execute(db)).rows[0],
				).toMatchObject({ customer_owned: 1 });
			},
		);

		it("associated metadata edits block later replacement without changing content version", async () => {
			const created = requireApplied(await repo.apply(request()));
			await new SeoRepository(db).upsert("page", created.entryId, { title: "Customer metadata" });
			const before = await snapshot(db);
			expect(await repo.apply(update(created))).toMatchObject({ state: "conflict" });
			expect(await snapshot(db)).toEqual(before);
			expect(
				(
					await sql`SELECT version FROM ec_page WHERE id = ${created.entryId} AND locale = 'en'`.execute(
						db,
					)
				).rows[0],
			).toMatchObject({ version: 1 });
		});

		it("rejects system column injection and safely binds field values", async () => {
			expect(await repo.apply(request({ data: { version: 99, title: "Unsafe" } }))).toMatchObject({
				state: "conflict",
			});
			await expect(
				repo.apply(request({ collection: "page; DROP TABLE revisions" })),
			).rejects.toThrow();
			await expect(
				repo.apply(request({ data: { "title; DROP TABLE revisions": "x" } })),
			).rejects.toThrow();
			const title = "'); DROP TABLE revisions; --";
			const created = requireApplied(await repo.apply(request({ data: { title } })));
			expect(
				(
					await sql`SELECT title FROM ec_page WHERE id = ${created.entryId} AND locale = 'en'`.execute(
						db,
					)
				).rows[0],
			).toMatchObject({ title });
		});

		it("can create a collection snapshot with no custom fields", async () => {
			expect((await repo.apply(request({ data: {} }))).state).toBe("applied");
		});

		for (const operation of ["create", "update"] as const) {
			for (const failure of ["abort", "ignore"] as const) {
				it.each(["revision", "content", "baseline", "prune", "complete"] as const)(
					`${operation} rolls back every effect when %s ${failure}s`,
					async (step) => {
						const created =
							operation === "update" ? requireApplied(await repo.apply(request())) : undefined;
						const target =
							step === "revision"
								? "revisions"
								: step === "content"
									? "ec_page"
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
						const before = await snapshot(db);
						await expect(repo.apply(created ? update(created) : request())).rejects.toThrow();
						expect(await snapshot(db)).toEqual(before);
					},
				);
			}
		}

		if (mode === "D1-style atomic adapter") {
			it("recovers a lost successful response using the durable operation without another revision", async () => {
				afterBatch = async () => {
					throw new Error("lost response after commit");
				};
				await expect(repo.apply(request())).rejects.toThrow("lost response after commit");
				const before = await snapshot(db);
				const replay = requireApplied(await repo.apply(request()));
				expect(replay.replayed).toBe(true);
				expect(await snapshot(db)).toEqual(before);
				expect(batches).toBe(1);
			});

			it.each(["missing", "replaced"])(
				"refuses a create if its sticky trigger becomes %s at the atomic boundary",
				async (kind) => {
					let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
					beforeBatch = async () => {
						await sql`DROP TRIGGER emdash_import_page_content_update`.execute(db);
						if (kind === "replaced") {
							await sql`CREATE TRIGGER emdash_import_page_content_update AFTER UPDATE ON ec_page BEGIN SELECT 1; END`.execute(
								db,
							);
						}
						raced = await snapshot(db);
					};
					expect((await repo.apply(request())).state).not.toBe("applied");
					expect(await snapshot(db)).toEqual(raced);
				},
			);

			it("rejects creation if the grant is revoked after preflight", async () => {
				let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
				beforeBatch = async () => {
					await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(db);
					raced = await snapshot(db);
				};
				expect((await repo.apply(request())).state).not.toBe("applied");
				expect(await snapshot(db)).toEqual(raced);
			});

			it.each(["revoke", "generation"])(
				"rejects grant %s after preflight and before the atomic batch with zero writes",
				async (kind) => {
					const created = requireApplied(await repo.apply(request()));
					let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
					beforeBatch = async () => {
						if (kind === "revoke")
							await sql`UPDATE _emdash_import_grants SET revoked = 1 WHERE id = 'grant-1'`.execute(
								db,
							);
						else
							await sql`UPDATE _emdash_import_grants SET generation = generation + 1 WHERE id = 'grant-1'`.execute(
								db,
							);
						raced = await snapshot(db);
					};
					expect((await repo.apply(update(created))).state).not.toBe("applied");
					expect(await snapshot(db)).toEqual(raced);
					expect(await repo.apply(request())).toEqual({ ...created, replayed: true });
				},
			);

			it("checks the baseline after a customer save racing the atomic boundary", async () => {
				const created = requireApplied(await repo.apply(request()));
				let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
				beforeBatch = async () => {
					await sql`UPDATE ec_page SET title = title WHERE id = ${created.entryId} AND locale = 'en'`.execute(
						db,
					);
					raced = await snapshot(db);
				};
				expect(await repo.apply(update(created))).toMatchObject({ state: "conflict" });
				expect(await snapshot(db)).toEqual(raced);
			});

			it("returns its own captured result when a customer save follows batch commit", async () => {
				const created = requireApplied(await repo.apply(request()));
				afterBatch = async () => {
					await sql`UPDATE ec_page SET title = 'Raced customer', version = version + 1 WHERE id = ${created.entryId} AND locale = 'en'`.execute(
						db,
					);
				};
				const result = requireApplied(await repo.apply(update(created)));
				expect(result.version).toBe(2);
				expect(
					(
						await sql`SELECT title, version FROM ec_page WHERE id = ${created.entryId} AND locale = 'en'`.execute(
							db,
						)
					).rows[0],
				).toMatchObject({ title: "Raced customer", version: 3 });
			});
		}
	});
}

describe("import capability", () => {
	it("does not mistake an unknown adapter for SQLite", async () => {
		const db = await setupTestDatabaseWithCollections();
		try {
			class UnknownAdapter extends SqliteAdapter {}
			const adapter = db.getExecutor().adapter;
			Object.setPrototypeOf(adapter, UnknownAdapter.prototype);
			expect(supportsAtomicImportSync(db)).toBe(false);
			expect(await new ImportSyncRepository(db).apply(request())).toEqual({
				state: "unknown",
				reason: "atomic_import_unavailable",
			});
			expect((await sql`SELECT * FROM revisions`.execute(db)).rows).toHaveLength(0);
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
