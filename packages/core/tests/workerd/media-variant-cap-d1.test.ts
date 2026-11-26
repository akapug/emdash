import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { MediaVariantRepository } from "../../src/database/repositories/media-variants.js";
import { MediaRepository } from "../../src/database/repositories/media.js";
import type { Database } from "../../src/database/types.js";
import { VARIANT_SLOT_CAP } from "../../src/media/variants.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

it("admits a single last slot on D1 and still repairs a committed slot at capacity", async () => {
	const db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	try {
		await resetD1Schema(db);
		await runMigrations(db);
		const parent = await new MediaRepository(db).create({
			filename: "parent.png",
			mimeType: "image/png",
			storageKey: "parent.png",
			size: 100,
			width: 128,
			height: 128,
			contentHash: "generation",
			status: "ready",
		});
		const repo = new MediaVariantRepository(db);
		const candidate = (width: number, storageKey = `variant-${width}`) => ({
			mediaId: parent.id,
			parentContentHash: "generation",
			sizeName: `size-${width}`,
			width,
			height: width,
			storageKey,
			bytes: 42,
			contentHash: `bytes-${width}`,
		});
		for (let width = 1; width < VARIANT_SLOT_CAP; width++) {
			const input = candidate(width);
			await repo.registerCandidate(input.storageKey);
			expect((await repo.store(input)).outcome).toBe("stored");
		}
		const contenders = [candidate(VARIANT_SLOT_CAP), candidate(VARIANT_SLOT_CAP + 1)];
		for (const input of contenders) await repo.registerCandidate(input.storageKey);
		const outcomes = await Promise.all(contenders.map((input) => repo.store(input)));
		const kinds = outcomes.map(({ outcome }) => outcome);
		expect(kinds).toContain("stored");
		expect(kinds).toContain("variant-slot-cap");

		const repair = candidate(1, "repaired-variant");
		await repo.registerCandidate(repair.storageKey);
		expect(await repo.store(repair, candidate(1).storageKey)).toEqual({
			outcome: "replayed",
			storageKey: repair.storageKey,
		});
		expect(await repo.forParent(parent.id, "generation")).toHaveLength(VARIANT_SLOT_CAP);
	} finally {
		await db.destroy();
	}
});
