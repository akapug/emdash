import { sql, type Kysely } from "kysely";
import { expect, it } from "vitest";

import { up } from "../../src/database/migrations/089_import_sync_grants.js";
import { ImportSyncGrantRepository } from "../../src/database/repositories/import-sync-grant.js";
import type { Database } from "../../src/database/types.js";

const identity = {
	sourceSite: "https://source.example",
	bindingId: "binding-one",
	actorId: "import-actor",
};

export function importSyncGrantCases(getDb: () => Kysely<Database>): void {
	it("issues a server-generated grant for the exact source, binding and actor", async () => {
		const repository = new ImportSyncGrantRepository(getDb());
		const grant = await repository.create(identity);
		expect(grant).toMatchObject({ ...identity, generation: 1, revoked: false });
		expect(grant.id).toBeTruthy();
		expect(await repository.find(grant.id)).toEqual(grant);
	});

	it("makes revocation sticky and advances generation exactly once", async () => {
		const repository = new ImportSyncGrantRepository(getDb());
		const grant = await repository.create(identity);
		const revoked = { ...grant, generation: grant.generation + 1, revoked: true };
		expect(await repository.revoke(grant.id)).toEqual(revoked);
		const db = getDb();
		const tombstone = await db
			.selectFrom("_emdash_import_grants")
			.selectAll()
			.where("id", "=", grant.id)
			.executeTakeFirst();
		expect(await repository.revoke(grant.id)).toEqual(revoked);
		expect(await repository.find(grant.id)).toEqual(revoked);
		expect(
			await db
				.selectFrom("_emdash_import_grants")
				.selectAll()
				.where("id", "=", grant.id)
				.executeTakeFirst(),
		).toEqual(tombstone);
	});

	it("does not advance generation twice when revocations race", async () => {
		const repository = new ImportSyncGrantRepository(getDb());
		const grant = await repository.create(identity);
		const other = new ImportSyncGrantRepository(getDb());
		const results = await Promise.all([
			repository.revoke(grant.id),
			other.revoke(grant.id),
			repository.revoke(grant.id),
		]);
		const revoked = { ...grant, generation: grant.generation + 1, revoked: true };
		expect(results).toEqual([revoked, revoked, revoked]);
		expect(await repository.find(grant.id)).toEqual(revoked);
	});

	it("returns null for a missing grant without issuing authority", async () => {
		const db = getDb();
		const repository = new ImportSyncGrantRepository(db);
		expect(await repository.find("missing")).toBeNull();
		expect(await repository.revoke("missing")).toBeNull();
		expect(await db.selectFrom("_emdash_import_grants").selectAll().execute()).toEqual([]);
	});

	it("issues fresh authority without reusing a revoked grant or accepting caller-supplied state", async () => {
		const repository = new ImportSyncGrantRepository(getDb());
		const original = await repository.create(identity);
		const revoked = await repository.revoke(original.id);
		const input = { ...identity, id: original.id, generation: 99, revoked: true };
		const next = await repository.create(input);
		expect(next.id).not.toBe(original.id);
		expect(next).toMatchObject({ ...identity, generation: 1, revoked: false });
		expect(await repository.find(original.id)).toEqual(revoked);
	});

	it("keeps grants independent across source, binding and actor identities", async () => {
		const repository = new ImportSyncGrantRepository(getDb());
		const first = await repository.create(identity);
		const second = await repository.create({ ...identity, bindingId: "binding-two" });
		const third = await repository.create({
			...identity,
			sourceSite: "https://other.example",
			actorId: "other-actor",
		});
		await repository.revoke(first.id);
		expect(await repository.find(second.id)).toEqual(second);
		expect(await repository.find(third.id)).toEqual(third);
	});

	it.each(["sourceSite", "bindingId", "actorId"] as const)(
		"refuses an empty %s without issuing authority",
		async (key) => {
			const db = getDb();
			const repository = new ImportSyncGrantRepository(db);
			await expect(repository.create({ ...identity, [key]: " " })).rejects.toThrow(
				"require source site, binding and actor identity",
			);
			expect(await db.selectFrom("_emdash_import_grants").selectAll().execute()).toEqual([]);
		},
	);

	it("propagates failed revocation rather than reporting a revoked grant", async () => {
		const db = getDb();
		const repository = new ImportSyncGrantRepository(db);
		const grant = await repository.create(identity);
		await sql`CREATE TRIGGER refuse_grant_revoke BEFORE UPDATE ON _emdash_import_grants
			BEGIN SELECT RAISE(ABORT, 'grant revoke failed'); END`.execute(db);
		await expect(repository.revoke(grant.id)).rejects.toThrow("grant revoke failed");
		expect(await repository.find(grant.id)).toEqual(grant);
	});

	it("retains revoked authority and generation when schema expansion is replayed", async () => {
		const db = getDb();
		const repository = new ImportSyncGrantRepository(db);
		const grant = await repository.create(identity);
		const revoked = await repository.revoke(grant.id);
		await up(db);
		await up(db);
		expect(await repository.find(grant.id)).toEqual(revoked);
	});

	it("preserves completed legacy receipts with unknown grant identity", async () => {
		const db = getDb();
		await sql`INSERT INTO _emdash_import_operations
			(operation_id, source_site, source_type, source_id, collection, entry_id, locale,
			sequence, request_hash, revision_id, version, completed)
			VALUES ('legacy-operation', 'https://source.example', 'post', 'source-entry', 'post', 'entry', 'en',
			1, 'accepted-request', 'original', 1, 1)`.execute(db);
		await up(db);
		const row = await db
			.selectFrom("_emdash_import_operations")
			.select(["completed", "revision_id", "grant_id", "grant_generation", "binding_id"])
			.where("operation_id", "=", "legacy-operation")
			.executeTakeFirst();
		expect(row).toEqual({
			completed: 1,
			revision_id: "original",
			grant_id: null,
			grant_generation: null,
			binding_id: null,
		});
	});
}
