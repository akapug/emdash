import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSystemCleanup } from "../../../src/cleanup.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { MEDIA_VARIANT_STORAGE_PREFIX } from "../../../src/transfer/staging/keys.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";

const OLD = "2020-01-01T00:00:00.000Z";
const key = (name: string) => `${MEDIA_VARIANT_STORAGE_PREFIX}${name}.jpg`;

describe("media variant system cleanup", () => {
	let db: Kysely<Database>;
	let storage: ReturnType<typeof createMemoryStorage>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		storage = createMemoryStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	async function queue(storageKey: string, reason: "pending" | "retired", createdAt = OLD) {
		await db
			.insertInto("_emdash_media_variant_cleanup")
			.values({ storage_key: storageKey, reason, created_at: createdAt })
			.execute();
	}

	async function storeObject(storageKey: string) {
		await storage.upload({ key: storageKey, body: new Uint8Array([1]), contentType: "image/jpeg" });
	}

	async function marker(storageKey: string) {
		return db
			.selectFrom("_emdash_media_variant_cleanup")
			.select("reason")
			.where("storage_key", "=", storageKey)
			.executeTakeFirst();
	}

	it("keeps retry records without storage or after a failed delete and clears them after success", async () => {
		const retired = key("retired");
		const alreadyAbsent = key("absent");
		await storeObject(retired);
		await queue(retired, "retired");
		await queue(alreadyAbsent, "retired");

		await runSystemCleanup(db);
		expect(await marker(retired)).toEqual({ reason: "retired" });

		const deleteObject = storage.delete.bind(storage);
		const remove = vi.spyOn(storage, "delete").mockImplementation(async (storageKey) => {
			if (storageKey === retired) throw new Error("storage unavailable for this key");
			await deleteObject(storageKey);
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		await runSystemCleanup(db, storage);
		expect(await storage.exists(retired)).toBe(true);
		expect(await marker(retired)).toEqual({ reason: "retired" });
		expect(await marker(alreadyAbsent)).toBeUndefined();
		expect(log).toHaveBeenCalledWith(expect.stringContaining(retired), expect.any(Error));

		remove.mockRestore();
		await runSystemCleanup(db, storage);
		expect(await storage.exists(retired)).toBe(false);
		expect(await marker(retired)).toBeUndefined();
	});

	it("claims old pending keys before deletion, but leaves young pending uploads in both timestamp formats", async () => {
		const oldIso = key("old-iso");
		const oldSqlite = key("old-sqlite");
		const youngIso = key("young-iso");
		const youngSqlite = key("young-sqlite");
		for (const [storageKey, createdAt] of [
			[oldIso, "2026-03-16T10:59:59.999Z"],
			[oldSqlite, "2026-03-16 10:59:59"],
			[youngIso, "2026-03-16T11:00:00.000Z"],
			[youngSqlite, "2026-03-16 11:30:00"],
		] as const) {
			await storeObject(storageKey);
			await queue(storageKey, "pending", createdAt);
		}

		const deleteObject = storage.delete.bind(storage);
		const claims = new Map<string, string | undefined>();
		const remove = vi.spyOn(storage, "delete").mockImplementation(async (storageKey) => {
			claims.set(storageKey, (await marker(storageKey))?.reason);
			await deleteObject(storageKey);
		});
		// A raw string comparison would collect the young SQLite-format key:
		// its space separator sorts before the ISO cutoff's T on the same day.
		vi.setSystemTime(new Date("2026-03-16T12:00:00.000Z"));
		try {
			await runSystemCleanup(db, storage);
		} finally {
			vi.useRealTimers();
		}
		expect(remove).toHaveBeenCalledTimes(2);
		for (const storageKey of [oldIso, oldSqlite]) {
			expect(claims.get(storageKey)).toBe("retired");
			expect(await storage.exists(storageKey)).toBe(false);
			expect(await marker(storageKey)).toBeUndefined();
		}
		for (const storageKey of [youngIso, youngSqlite]) {
			expect(await storage.exists(storageKey)).toBe(true);
			expect(await marker(storageKey)).toEqual({ reason: "pending" });
		}
	});

	it("refuses both kinds of live references and keys outside the private variant directory", async () => {
		const master = key("master");
		const variant = key("variant");
		const outside = "uploads/other.jpg";
		const traversal = `${MEDIA_VARIANT_STORAGE_PREFIX}../${outside}`;
		const parent = await new MediaRepository(db).create({
			filename: "master.jpg",
			mimeType: "image/jpeg",
			storageKey: master,
			contentHash: "parent-hash",
		});
		await queue(variant, "pending");
		await db
			.insertInto("_emdash_media_variants")
			.values({
				media_id: parent.id,
				size_name: "small",
				width: 100,
				height: 100,
				storage_key: variant,
				bytes: 1,
				content_hash: "variant-hash",
				parent_content_hash: "parent-hash",
			})
			.execute();
		// Seed a stale pending marker even when admission consumed the original.
		await db
			.deleteFrom("_emdash_media_variant_cleanup")
			.where("storage_key", "=", variant)
			.execute();
		await queue(variant, "pending");
		await queue(master, "retired");
		await queue(outside, "retired");
		await queue(traversal, "retired");
		for (const storageKey of [master, variant, outside, traversal]) await storeObject(storageKey);

		const remove = vi.spyOn(storage, "delete");
		await runSystemCleanup(db, storage);

		expect(remove).not.toHaveBeenCalled();
		expect(await marker(variant)).toEqual({ reason: "pending" });
		for (const storageKey of [master, variant, outside, traversal]) {
			expect(await storage.exists(storageKey)).toBe(true);
			expect(await marker(storageKey)).toBeDefined();
		}
	});

	it("leaves a fresh retirement recorded after the sweep already deleted the object", async () => {
		const late = key("late-upload");
		await queue(late, "pending");
		const deleteObject = storage.delete.bind(storage);
		const remove = vi.spyOn(storage, "delete").mockImplementationOnce(async (storageKey) => {
			await deleteObject(storageKey);
			await storeObject(storageKey);
			await db
				.updateTable("_emdash_media_variant_cleanup")
				.set({ reason: "retired", created_at: "2199-01-01T00:00:00.000Z" })
				.where("storage_key", "=", storageKey)
				.execute();
		});

		await runSystemCleanup(db, storage);
		expect(await storage.exists(late)).toBe(true);
		expect(await marker(late)).toEqual({ reason: "retired" });

		remove.mockRestore();
		await runSystemCleanup(db, storage);
		expect(await storage.exists(late)).toBe(false);
		expect(await marker(late)).toBeUndefined();
	});

	it("bounds each sweep and resumes the queue on the next tick", async () => {
		const keys = Array.from({ length: 101 }, (_, index) => key(`batch-${index}`));
		for (const storageKey of keys) {
			await storeObject(storageKey);
			await queue(storageKey, "retired");
		}

		await runSystemCleanup(db, storage);
		expect(storage.files.size).toBe(1);

		await runSystemCleanup(db, storage);
		expect(storage.files.size).toBe(0);
		expect(await db.selectFrom("_emdash_media_variant_cleanup").selectAll().execute()).toEqual([]);
	});
});
