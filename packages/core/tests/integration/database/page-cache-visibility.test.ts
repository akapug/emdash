import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { ProtectedContentRepository } from "../../../src/database/repositories/protected-content.js";
import {
	activatePageCacheIncarnation,
	bumpVisibilityRev,
	readPageCacheAuthority,
	readVisibilityRev,
	retirePageCacheIncarnation,
	VISIBILITY_REV_OPTION,
} from "../../../src/page-cache/state.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupForDialect, teardownForDialect, type DialectTestContext } from "../../utils/test-db.js";

describe("page-cache D1-primary authority and visibility revision on real migrated schema", () => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect("sqlite");
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("performs ZERO visibility_rev writes when D1 primary has no active incarnation (absent or retired)", async () => {
		const content = new ContentRepository(ctx.db);
		const created = await content.create({
			type: "pages",
			data: {},
			status: "published",
			slug: "off-mode-page",
		});
		await content.unpublish("pages", created.id);
		await content.delete("pages", created.id);
		await content.permanentDelete("pages", created.id);
		expect(await readPageCacheAuthority(ctx.db)).toBeNull();
		expect(await readVisibilityRev(ctx.db)).toBe("0");

		// Even after an incarnation is activated and then retired (value = ''),
		// further visibility mutations match 0 rows and leave revision untouched.
		await activatePageCacheIncarnation(ctx.db, "d1-acme:inc-1", "rev-active-1");
		await retirePageCacheIncarnation(ctx.db, "rev-retired-1");
		expect(await readPageCacheAuthority(ctx.db)).toBeNull();
		expect(await readVisibilityRev(ctx.db)).toBe("rev-retired-1");

		const p2 = await content.create({
			type: "pages",
			data: {},
			status: "published",
			slug: "after-retire-page",
		});
		await content.unpublish("pages", p2.id);
		const registry = new SchemaRegistry(ctx.db);
		await registry.deleteCollection("pages", { force: true });
		expect(await readVisibilityRev(ctx.db)).toBe("rev-retired-1");
	});

	it("activates, bumps conditionally, and retires authoritative (activeIncarnation, visibilityRev) in options(name,value,revision)", async () => {
		expect(await readPageCacheAuthority(ctx.db)).toBeNull();
		// Conditional bump while OFF is a no-op
		await bumpVisibilityRev(ctx.db, "rev-should-not-write");
		expect(await readPageCacheAuthority(ctx.db)).toBeNull();

		const auth0 = await activatePageCacheIncarnation(ctx.db, "d1-acme:inc-1", "rev-0");
		expect(auth0).toEqual({ activeIncarnation: "d1-acme:inc-1", visibilityRev: "rev-0" });
		expect(await readPageCacheAuthority(ctx.db)).toEqual(auth0);

		await bumpVisibilityRev(ctx.db, "rev-1");
		expect(await readPageCacheAuthority(ctx.db)).toEqual({
			activeIncarnation: "d1-acme:inc-1",
			visibilityRev: "rev-1",
		});

		await retirePageCacheIncarnation(ctx.db, "rev-retired");
		expect(await readPageCacheAuthority(ctx.db)).toBeNull();
	});

	it("advances visibility_rev atomically on every public-visibility mutation when D1 primary is active (even from an OFF-era writer with no env flag), and skips ordinary draft saves", async () => {
		// Activate in D1 primary — no process env flag is set anywhere in this worker!
		await activatePageCacheIncarnation(ctx.db, "d1-acme:inc-1", "rev-start");
		const content = new ContentRepository(ctx.db);
		const created = await content.create({
			type: "pages",
			data: {},
			status: "published",
			slug: "public-page",
		});

		const rev0 = (await readPageCacheAuthority(ctx.db))!.visibilityRev;
		expect(rev0).toBe("rev-start");

		// Ordinary draft creation/save does NOT bump visibility_rev
		const draft = await content.create({
			type: "pages",
			data: {},
			status: "draft",
			slug: "ordinary-draft",
		});
		await content.update("pages", draft.id, { slug: "ordinary-draft-2" });
		expect((await readPageCacheAuthority(ctx.db))!.visibilityRev).toBe(rev0);

		// Unpublish (simulating an OFF-era writer completing during activation)
		await content.unpublish("pages", created.id);
		const rev1 = (await readPageCacheAuthority(ctx.db))!.visibilityRev;
		expect(rev1).not.toBe(rev0);

		// Re-publish then status -> draft via update
		await content.publish("pages", created.id);
		await content.update("pages", created.id, { status: "draft" });
		const rev2 = (await readPageCacheAuthority(ctx.db))!.visibilityRev;
		expect(rev2).not.toBe(rev1);

		// Soft-delete
		await content.delete("pages", created.id);
		const rev3 = (await readPageCacheAuthority(ctx.db))!.visibilityRev;
		expect(rev3).not.toBe(rev2);

		// Permanent delete
		await content.permanentDelete("pages", created.id);
		const rev4 = (await readPageCacheAuthority(ctx.db))!.visibilityRev;
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
		const rev5 = (await readPageCacheAuthority(ctx.db))!.visibilityRev;
		expect(rev5).not.toBe(rev4);

		// Forced collection delete
		const registry = new SchemaRegistry(ctx.db);
		await registry.deleteCollection("pages", { force: true });
		const rev6 = (await readPageCacheAuthority(ctx.db))!.visibilityRev;
		expect(rev6).not.toBe(rev5);
	});

	it("rolls back content unpublish atomically if the visibility revision update fails, and succeeds cleanly on retry", async () => {
		await activatePageCacheIncarnation(ctx.db, "d1-acme:inc-1", "rev-initial");
		const content = new ContentRepository(ctx.db);
		const created = await content.create({
			type: "pages",
			data: {},
			status: "published",
			slug: "atomic-page",
		});

		// Inject a SQLite trigger that forces the conditional UPDATE on options to fail
		await sql.raw(`
			CREATE TRIGGER fail_vis_rev BEFORE UPDATE ON options
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
		expect((await readPageCacheAuthority(ctx.db))!.visibilityRev).toBe("rev-initial");

		// Drop the fault trigger and retry -> both unpublish AND visibility_rev commit together
		await sql`DROP TRIGGER fail_vis_rev`.execute(ctx.db);
		const unpublished = await content.unpublish("pages", created.id);
		expect(unpublished.status).toBe("draft");
		expect((await readPageCacheAuthority(ctx.db))!.visibilityRev).not.toBe("rev-initial");
	});
});
