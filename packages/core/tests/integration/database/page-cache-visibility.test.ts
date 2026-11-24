import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { ProtectedContentRepository } from "../../../src/database/repositories/protected-content.js";
import {
	bumpVisibilityRev,
	readVisibilityRev,
	VISIBILITY_REV_OPTION,
} from "../../../src/page-cache/state.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupForDialect, teardownForDialect, type DialectTestContext } from "../../utils/test-db.js";

describe("page-cache visibility revision on real migrated schema", () => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect("sqlite");
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("reads and bumps emdash:visibility_rev against real migrated options(name,value,revision)", async () => {
		expect(await readVisibilityRev(ctx.db)).toBe("0");
		await bumpVisibilityRev(ctx.db);
		const r1 = await readVisibilityRev(ctx.db);
		expect(r1).not.toBe("0");

		// Stored via canonical OptionsRepository contract (name, value, revision)
		const opt = await new OptionsRepository(ctx.db).getVersioned<string>(VISIBILITY_REV_OPTION);
		expect(opt).not.toBeNull();
		expect(opt?.revision).toBe(r1);

		await bumpVisibilityRev(ctx.db);
		const r2 = await readVisibilityRev(ctx.db);
		expect(r2).not.toBe(r1);
	});

	it("advances visibility_rev atomically on unpublish, soft-delete, status->draft update, and forced collection delete", async () => {
		const content = new ContentRepository(ctx.db);
		const created = await content.create({
			type: "pages",
			data: {},
			status: "published",
			slug: "public-page",
		});

		const rev0 = await readVisibilityRev(ctx.db);

		// Unpublish
		await content.unpublish("pages", created.id);
		const rev1 = await readVisibilityRev(ctx.db);
		expect(rev1).not.toBe(rev0);

		// Re-publish then status -> draft via update
		await content.publish("pages", created.id);
		await content.update("pages", created.id, { status: "draft" });
		const rev2 = await readVisibilityRev(ctx.db);
		expect(rev2).not.toBe(rev1);

		// Soft-delete
		await content.delete("pages", created.id);
		const rev3 = await readVisibilityRev(ctx.db);
		expect(rev3).not.toBe(rev2);

		// Permanent delete
		await content.permanentDelete("pages", created.id);
		const rev4 = await readVisibilityRev(ctx.db);
		expect(rev4).not.toBe(rev3);

		// Protected content create
		const p2 = await content.create({
			type: "pages",
			data: {},
			status: "published",
			slug: "protected-page",
		});
		const protectedRepo = new ProtectedContentRepository(ctx.db);
		await protectedRepo.create(
			"pages",
			p2.id,
			{
				version: 1,
				mode: "password",
				verifier: {
					version: 1,
					algorithm: "pbkdf2-sha256",
					iterations: 100000,
					salt: "0".repeat(32),
					hash: "a".repeat(64),
				},
			},
			{},
		);
		const rev5 = await readVisibilityRev(ctx.db);
		expect(rev5).not.toBe(rev4);

		// Forced collection delete
		const registry = new SchemaRegistry(ctx.db);
		await registry.deleteCollection("pages", { force: true });
		const rev6 = await readVisibilityRev(ctx.db);
		expect(rev6).not.toBe(rev5);
	});

	it("rolls back content unpublish atomically if the visibility revision write fails, and succeeds cleanly on retry", async () => {
		const content = new ContentRepository(ctx.db);
		const created = await content.create({
			type: "pages",
			data: {},
			status: "published",
			slug: "atomic-page",
		});

		// Inject a SQLite trigger that forces the visibility revision write to fail
		await sql.raw(`
			CREATE TRIGGER fail_vis_rev BEFORE INSERT ON options
			WHEN NEW.name = '${VISIBILITY_REV_OPTION}'
			BEGIN
				SELECT RAISE(ABORT, 'injected visibility_rev failure');
			END
		`).execute(ctx.db);

		await expect(content.unpublish("pages", created.id)).rejects.toThrow(
			/injected visibility_rev failure/,
		);

		// Content MUST still be published (rolled back atomically!)
		const afterFail = await content.findById("pages", created.id);
		expect(afterFail?.status).toBe("published");
		expect(await readVisibilityRev(ctx.db)).toBe("0");

		// Drop the fault trigger and retry -> both unpublish AND visibility_rev commit together
		await sql`DROP TRIGGER fail_vis_rev`.execute(ctx.db);
		const unpublished = await content.unpublish("pages", created.id);
		expect(unpublished.status).toBe("draft");
		expect(await readVisibilityRev(ctx.db)).not.toBe("0");
	});
});
