import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database/connection.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { chooseVariant, type StoredVariant, type VariantParent } from "../../src/media/variants.js";

/**
 * The variant lifecycle against a real D1-shaped database, because the rules that
 * matter are the ones the SCHEMA enforces, not the ones a pure function agrees to.
 *
 * The arm the lead asked for by name is last: after a rollback, the SAME `?w=`
 * URL must answer the original. That is the whole reason the public URL is the
 * parent's and the cache policy is mutable.
 */

let db: Database;

beforeEach(async () => {
	db = createDatabase({ url: ":memory:" });
	await runMigrations(db);
	await sql`INSERT INTO media (id, filename, mime_type, size, width, height, storage_key, status)
		VALUES ('m1', 'portrait.jpg', 'image/jpeg', 9555168, 4414, 6122, '01PARENT.jpg', 'ready')`.execute(db);
});

afterEach(async () => {
	await db.destroy();
});

const PARENT: VariantParent = { id: "m1", width: 4414, height: 6122, contentHash: "sha1:original", status: "ready" };

async function storeRow(over: Partial<StoredVariant> & { mediaId: string }) {
	const row = {
		sizeName: "medium",
		width: 768,
		height: 1065,
		storageKey: "01VARIANT",
		bytes: 90_000,
		contentHash: "sha256:aaa",
		parentContentHash: "sha1:original",
		...over,
	};
	await sql`INSERT INTO _emdash_media_variants
		(media_id, size_name, width, height, storage_key, bytes, content_hash, parent_content_hash)
		VALUES (${row.mediaId}, ${row.sizeName}, ${row.width}, ${row.height},
			${row.storageKey}, ${row.bytes}, ${row.contentHash}, ${row.parentContentHash})`.execute(db);
}

async function storedOnDisk(): Promise<StoredVariant[]> {
	const { rows } = await sql<StoredVariant>`SELECT media_id AS mediaId, size_name AS sizeName, width,
		height, storage_key AS storageKey, bytes, content_hash AS contentHash,
		parent_content_hash AS parentContentHash, created_at AS createdAt
		FROM _emdash_media_variants`.execute(db);
	return [...rows];
}

describe("the variant lifecycle the schema enforces", () => {
	it("stores a variant and resolves it for a hint at or below its width", async () => {
		await storeRow({ mediaId: "m1" });
		expect(chooseVariant(PARENT, await storedOnDisk(), 480)?.width).toBe(768);
		expect(chooseVariant(PARENT, await storedOnDisk(), 768)?.width).toBe(768);
	});

	it("a hint ABOVE every stored variant answers the original — never a smaller image than asked for", async () => {
		await storeRow({ mediaId: "m1" });
		// The lead's rule is "smallest width >= w". Nothing here is >= 852, so the
		// original streams. This is the safe direction: serving 768 for a 1440px slot
		// would be a blurry photograph, not a saving.
		expect(chooseVariant(PARENT, await storedOnDisk(), 852)).toBeNull();
	});

	it("a duplicate at the same slot is a primary-key conflict, not a second row", async () => {
		await storeRow({ mediaId: "m1" });
		await expect(storeRow({ mediaId: "m1" })).rejects.toThrow();
		expect(await storedOnDisk()).toHaveLength(1);
	});

	it("different bytes at the same slot cannot overwrite — the key holds", async () => {
		await storeRow({ mediaId: "m1" });
		await expect(storeRow({ mediaId: "m1", contentHash: "sha256:bbb" })).rejects.toThrow();
		const rows = await storedOnDisk();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.contentHash).toBe("sha256:aaa");
	});

	it("deleting the parent retires its variant rows by cascade", async () => {
		await storeRow({ mediaId: "m1" });
		await sql`DELETE FROM media WHERE id = 'm1'`.execute(db);
		expect(await storedOnDisk()).toHaveLength(0);
	});

	it("a REPLACED parent stops serving its old variants — its content hash moves and the rows fall behind", async () => {
		await storeRow({ mediaId: "m1" });
		const rows = await storedOnDisk();
		// The parent is replaced: Replace rewrites `content_hash`, which is the identity
		// `media` actually has. The old rows still name the OLD hash, so they are
		// invisible without anyone sweeping them.
		const replaced: VariantParent = { ...PARENT, contentHash: "sha1:replaced" };
		expect(chooseVariant(replaced, rows, 300)).toBeNull();
		// The hash they were stored under still resolves them, which is what a rollback
		// of the replace would return to.
		expect(chooseVariant(PARENT, rows, 300)?.width).toBe(768);
	});

	it("AFTER A ROLLBACK THE SAME ?w= URL ANSWERS THE ORIGINAL — the arm this design exists for", async () => {
		const hint = 480;
		await storeRow({ mediaId: "m1" });
		// 1. With the variant committed, the width-hinted request gets the variant.
		const before = chooseVariant(PARENT, await storedOnDisk(), hint);
		expect(before, "the variant serves before a rollback").not.toBeNull();
		expect(before?.storageKey).toBe("01VARIANT");

		// 2. The rollback retires the row (the backfill command's --rollback does this),
		//    and the objects it names are deleted from storage by that same command.
		await sql`DELETE FROM _emdash_media_variants WHERE media_id = 'm1'`.execute(db);

		// 3. The SAME url — same parent, same hint — now answers the original, which is
		//    null: the caller streams the parent. No stale object can be served, because
		//    no variant key is in the URL and the resolver found no row.
		expect(chooseVariant(PARENT, await storedOnDisk(), hint)).toBeNull();
	});

	it("the down migration refuses to drop a populated table — the objects would be orphaned", async () => {
		await storeRow({ mediaId: "m1" });
		const { down } = await import("../../src/database/migrations/embark_005_media_variants.js");
		await expect(down(db)).rejects.toThrow(/retire their objects/);
	});
});
