import { randomUUID } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import Database from "better-sqlite3";
import { SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { ImportSyncRequest } from "../../../src/import/sync.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const actor = { id: "importer", role: Role.ADMIN };
const initial: ImportSyncRequest = {
	version: 1,
	operationId: "receipt-1",
	source: { site: "https://source.example", type: "page", id: "42" },
	collection: "pages",
	locale: "en",
	sequence: 1,
	slug: "home",
	data: { title: "Home" },
};

describe("runtime import sync", () => {
	let runtime: EmDashRuntime;
	let saves: number;
	let interveningSave: (() => Promise<void>) | undefined;

	beforeEach(async () => {
		saves = 0;
		interveningSave = undefined;
		runtime = await EmDashRuntime.create({
			config: {
				database: { entrypoint: `test-import-sync-${randomUUID()}`, config: {}, type: "sqlite" },
			},
			createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
			plugins: [
				definePlugin({
					id: "import-sync-probe",
					version: "1.0.0",
					capabilities: ["content:write"],
					hooks: {
						"content:beforeSave": async (event) => {
							saves++;
							await interveningSave?.();
							return { ...event.content, title: `${String(event.content.title)} [normalized]` };
						},
					},
				}),
			],
		});
		const registry = new SchemaRegistry(runtime.db);
		await registry.createCollection({ slug: "pages", label: "Pages", supports: ["revisions"] });
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("pages", { slug: "excerpt", label: "Excerpt", type: "text" });
	});

	afterEach(async () => {
		await runtime?.stopCron();
	});

	async function create() {
		const result = await runtime.handleImportSync(initial, actor);
		expect(result.success).toBe(true);
		if (!result.success || result.data.state !== "applied")
			throw new Error("Import was not applied");
		return result.data;
	}

	it("validates hook output, stores its own snapshot and replays without rerunning hooks", async () => {
		expect(await runtime.getImportSyncCapability("pages")).toEqual({ version: 1, available: true });
		const created = await create();
		const revision = await new RevisionRepository(runtime.db).findById(created.revisionId);
		expect(revision?.data.title).toBe("Home [normalized]");
		const replay = await runtime.handleImportSync(initial, actor);
		expect(replay).toEqual({ success: true, data: { ...created, replayed: true } });
		expect(saves).toBe(1);
		const mismatch = await runtime.handleImportSync(
			{ ...initial, data: { title: "Forged" } },
			actor,
		);
		expect(mismatch).toEqual({
			success: true,
			data: { state: "conflict", reason: "operation_identity_mismatch" },
		});
		expect(saves).toBe(1);
	});

	it("clears omitted optional fields in the published row and its matching snapshot", async () => {
		const first = await runtime.handleImportSync(
			{ ...initial, data: { title: "Home", excerpt: "Old excerpt" } },
			actor,
		);
		if (!first.success || first.data.state !== "applied") throw new Error("Import was not applied");
		const updated = await runtime.handleImportSync(
			{
				...initial,
				operationId: "receipt-2",
				sequence: 2,
				entryId: first.data.entryId,
				expectedVersion: first.data.version,
				data: { title: "Updated" },
			},
			actor,
		);
		expect(updated.success && updated.data.state).toBe("applied");
		if (!updated.success || updated.data.state !== "applied")
			throw new Error("Update was not applied");
		const item = await new ContentRepository(runtime.db).findById("pages", first.data.entryId);
		const revision = await new RevisionRepository(runtime.db).findById(updated.data.revisionId);
		const stored = await sql<{ excerpt: string | null }>`SELECT excerpt FROM ec_pages
			WHERE id = ${first.data.entryId} AND locale = ${initial.locale}`.execute(runtime.db);
		expect(stored.rows).toEqual([{ excerpt: null }]);
		expect(item?.data).not.toHaveProperty("excerpt");
		expect(revision?.data.excerpt).toBeNull();
		expect(revision?.data.title).toBe(item?.data.title);
		expect(updated.data.originalRevisionId).toBe(first.data.originalRevisionId);
	});

	it("does not replace a page changed during beforeSave preparation", async () => {
		const created = await create();
		interveningSave = async () => {
			interveningSave = undefined;
			await new ContentRepository(runtime.db).update("pages", created.entryId, {
				data: { title: "Customer edit" },
			});
		};
		const result = await runtime.handleImportSync(
			{
				...initial,
				operationId: "receipt-2",
				sequence: 2,
				entryId: created.entryId,
				expectedVersion: created.version,
				data: { title: "Source update" },
			},
			actor,
		);
		expect(result.success && result.data.state).not.toBe("applied");
		const item = await new ContentRepository(runtime.db).findById("pages", created.entryId);
		expect(item?.data.title).toBe("Customer edit");
		const revisions = await runtime.db.selectFrom("revisions").select("id").execute();
		expect(revisions).toHaveLength(1);
	});

	it.each(["set", "attach", "detach", "clear"])(
		"treats a same-value empty taxonomy %s as a customer save",
		async (action) => {
			const created = await create();
			const taxonomy = new TaxonomyRepository(runtime.db);
			if (action === "set")
				await taxonomy.setTermsForEntry("pages", created.entryId, "category", []);
			if (action === "attach") await taxonomy.attachGroupsToEntry("pages", created.entryId, []);
			if (action === "detach") await taxonomy.detachGroupsFromEntry("pages", created.entryId, []);
			if (action === "clear") await taxonomy.clearEntryTerms("pages", created.entryId);
			const baseline = await runtime.db
				.selectFrom("_emdash_import_baselines")
				.selectAll()
				.executeTakeFirstOrThrow();
			expect(baseline.customer_owned).toBe(1);
			const result = await runtime.handleImportSync(
				{
					...initial,
					operationId: "receipt-2",
					sequence: 2,
					entryId: created.entryId,
					expectedVersion: created.version,
					data: { title: "Source update" },
				},
				actor,
			);
			expect(result.success && result.data.state).toBe("conflict");
			expect(saves).toBe(1);
		},
	);

	it("never adopts a legacy row from a matching slug or a supplied entry id", async () => {
		const legacy = await new ContentRepository(runtime.db).create({
			type: "pages",
			slug: initial.slug,
			locale: initial.locale,
			status: "published",
			data: { title: "Legacy customer content" },
		});
		const collision = await runtime.handleImportSync(initial, actor);
		expect(collision.success && collision.data.state).toBe("conflict");
		const adoption = await runtime.handleImportSync(
			{
				...initial,
				entryId: legacy.id,
				expectedVersion: legacy.version,
			},
			actor,
		);
		expect(adoption.success && adoption.data.state).toBe("unknown");
		expect(saves).toBe(0);
		expect(await runtime.db.selectFrom("_emdash_import_baselines").selectAll().execute()).toEqual(
			[],
		);
		expect((await new ContentRepository(runtime.db).findById("pages", legacy.id))?.data.title).toBe(
			"Legacy customer content",
		);
	});

	it("declines collections without revision support before save hooks", async () => {
		await new SchemaRegistry(runtime.db).createCollection({
			slug: "plain",
			label: "Plain",
			supports: [],
		});
		expect(await runtime.getImportSyncCapability("plain")).toEqual({
			version: 1,
			available: false,
		});
		const result = await runtime.handleImportSync({ ...initial, collection: "plain" }, actor);
		expect(result.success && result.data.state).toBe("unknown");
		expect(saves).toBe(0);
	});

	it("rejects invalid field data and non-import actors before any atomic write", async () => {
		const denied = await runtime.handleImportSync(initial, {
			id: "subscriber",
			role: Role.SUBSCRIBER,
		});
		expect(denied.success).toBe(false);
		expect(saves).toBe(0);
		const invalid = await runtime.handleImportSync({ ...initial, data: { rogue: "field" } }, actor);
		expect(invalid.success).toBe(false);
		expect(await runtime.db.selectFrom("_emdash_import_operations").selectAll().execute()).toEqual(
			[],
		);
	});
});
