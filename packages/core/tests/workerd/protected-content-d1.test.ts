import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { createPasswordVerifier, verifyContentPassword } from "../../src/content/protection.js";
import { up, down } from "../../src/database/migrations/embark_003_protected_content.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { ProtectedContentRepository } from "../../src/database/repositories/protected-content.js";
import { ContentMutationConflictError } from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}
let db: Kysely<Database>;
beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});
beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
});
afterAll(async () => {
	await db.destroy();
});

describe("protected payload on the Worker and D1 runtime", () => {
	it("derives and verifies exact UTF-8 passwords within the Worker PBKDF2 limit", async () => {
		const password = " yes é ";
		const verifier = await createPasswordVerifier(password);
		expect(await verifyContentPassword(password, verifier)).toBe(true);
		expect(await verifyContentPassword(password.trim(), verifier)).toBe(false);
		expect(await verifyContentPassword("wrong", verifier)).toBe(false);
	});
	it("restarts expansion, rolls back unused schema, and publishes only a safe projection", async () => {
		await up(db);
		await down(db);
		await down(db);
		await up(db);
		await up(db);
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createField("pages", { slug: "excerpt", label: "Excerpt", type: "text" });
		const verifier = await createPasswordVerifier("yes");
		const item = await new ContentRepository(db).create({
			type: "pages",
			slug: "protected",
			status: "published",
			data: { title: "Protected title", excerpt: "SYNTHETIC_D1_PRIVATE_72f3" },
			protection: { version: 1, mode: "password", verifier },
		});
		expect(item.status).toBe("published");
		expect(JSON.stringify(item)).not.toContain("SYNTHETIC_D1_PRIVATE_72f3");
		expect((await new ProtectedContentRepository(db).readData(item))?.excerpt).toBe(
			"SYNTHETIC_D1_PRIVATE_72f3",
		);
		await expect(down(db)).rejects.toThrow("Protected content exists");
	});
	it("rolls back protected creation and rejects concurrent version conflicts atomically on D1", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createField("pages", { slug: "excerpt", label: "Excerpt", type: "text" });
		const verifier = await createPasswordVerifier("yes");
		const repo = new ContentRepository(db);
		const item = await repo.create({
			type: "pages",
			slug: "protected-d1",
			status: "published",
			data: { title: "Protected D1", excerpt: "SYNTHETIC_D1_ORIGINAL" },
			protection: { version: 1, mode: "password", verifier },
		});
		// Create failure must leave no orphan private row on D1 atomic batch.
		await expect(
			repo.create({
				type: "pages",
				slug: "protected-d1-fail",
				status: "published",
				data: { title: "Bad D1", unknown_column: "triggers-d1-error" },
				protection: { version: 1, mode: "password", verifier },
			}),
		).rejects.toThrow(/table ec_pages has no column named unknown_column/i);
		expect(await db.selectFrom("_emdash_protected_content").selectAll().execute()).toHaveLength(1);

		// Concurrent version conflict on D1 batch must throw and preserve private payload.
		let bumped = false;
		const raceDb = db.withPlugin({
			transformQuery: ({ node }) => node,
			async transformResult(args) {
				if (
					!bumped &&
					args.result.rows.length === 1 &&
					(args.result.rows[0] as Record<string, unknown>)?.id === item.id &&
					(args.result.rows[0] as Record<string, unknown>)?.version === item.version
				) {
					bumped = true;
					await db
						.updateTable("ec_pages" as keyof Database)
						.set({ version: item.version + 1 } as never)
						.where("id" as never, "=", item.id)
						.execute();
				}
				return args.result;
			},
		});
		await expect(
			new ContentRepository(raceDb).update("pages", item.id, {
				data: { excerpt: "SYNTHETIC_D1_RACED" },
			}),
		).rejects.toBeInstanceOf(ContentMutationConflictError);
		expect(bumped).toBe(true);
		expect((await new ProtectedContentRepository(db).readData(item))?.excerpt).toBe(
			"SYNTHETIC_D1_ORIGINAL",
		);
	});
});
