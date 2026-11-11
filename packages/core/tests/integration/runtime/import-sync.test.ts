import { randomUUID } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import Database from "better-sqlite3";
import { SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeReferenceSelection } from "../../../src/api/handlers/relations.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { ImportSyncGrantRepository } from "../../../src/database/repositories/import-sync-grant.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
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
	grant: { id: "grant-1", bindingId: "binding-1", generation: 1 },
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
	let afterSaves: Record<string, unknown>[];

	beforeEach(async () => {
		saves = 0;
		interveningSave = undefined;
		afterSaves = [];
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
						"content:afterSave": async (event) => {
							afterSaves.push(event.content);
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
		const grant = await new ImportSyncGrantRepository(runtime.db).create({
			sourceSite: initial.source.site,
			bindingId: "binding-1",
			actorId: actor.id,
		});
		initial.grant = { id: grant.id, bindingId: grant.bindingId, generation: grant.generation };
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
		expect(await runtime.getImportSyncCapability("pages")).toEqual({
			version: 1,
			available: true,
			mappedFieldsOnly: true,
			grantGenerationFence: true,
		});
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

	it("preserves unmapped custom fields in the published row and its matching snapshot", async () => {
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
		expect(stored.rows).toEqual([{ excerpt: "Old excerpt" }]);
		expect(item?.data.excerpt).toBe("Old excerpt");
		expect(revision?.data.excerpt).toBe("Old excerpt");
		expect(revision?.data.title).toBe(item?.data.title);
		expect(updated.data.originalRevisionId).toBe(first.data.originalRevisionId);
		await vi.waitFor(() => expect(afterSaves).toHaveLength(2));
		expect(afterSaves[1]).toMatchObject({
			id: first.data.entryId,
			title: item?.data.title,
			excerpt: "Old excerpt",
		});
	});

	it("preserves an omitted required field even when a hook returns a value for it", async () => {
		const created = await create();
		const updated = await runtime.handleImportSync(
			{
				...initial,
				operationId: "receipt-2",
				sequence: 2,
				entryId: created.entryId,
				expectedVersion: created.version,
				data: { excerpt: "Mapped excerpt" },
			},
			actor,
		);
		if (!updated.success || updated.data.state !== "applied")
			throw new Error("Update was not applied");
		const item = await new ContentRepository(runtime.db).findById("pages", created.entryId);
		const revision = await new RevisionRepository(runtime.db).findById(updated.data.revisionId);
		expect(item?.data).toEqual({ title: "Home [normalized]", excerpt: "Mapped excerpt" });
		expect(revision?.data.title).toBe(item?.data.title);
		expect(revision?.data.excerpt).toBe(item?.data.excerpt);
	});

	it("does not commit after an authenticated request loses its import grant during save hooks", async () => {
		const created = await create();
		interveningSave = async () => {
			interveningSave = undefined;
			const revoked = await new ImportSyncGrantRepository(runtime.db).revoke(initial.grant.id);
			expect(revoked?.generation).toBe(initial.grant.generation + 1);
		};
		const result = await runtime.handleImportSync(
			{
				...initial,
				operationId: "receipt-2",
				sequence: 2,
				entryId: created.entryId,
				expectedVersion: created.version,
				data: { title: "Forbidden after fence" },
			},
			actor,
		);
		expect(result.success && result.data.state).not.toBe("applied");
		expect(saves).toBe(2);
		const item = await new ContentRepository(runtime.db).findById("pages", created.entryId);
		expect(item?.data.title).toBe("Home [normalized]");
		expect(await runtime.db.selectFrom("revisions").select("id").execute()).toHaveLength(1);
		expect(
			await runtime.db.selectFrom("_emdash_import_operations").select("operation_id").execute(),
		).toEqual([{ operation_id: initial.operationId }]);
		expect(await runtime.handleImportSync(initial, actor)).toEqual({
			success: true,
			data: { ...created, replayed: true },
		});
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

	it.each([
		"parent with a child",
		"parent with an unchanged empty set",
		"child",
		"child with an unchanged empty set of parents",
	])("treats a reference edit as the imported page's %s as a customer save", async (side) => {
		const created = await create();
		await new SchemaRegistry(runtime.db).createCollection({ slug: "notes", label: "Notes" });
		const content = new ContentRepository(runtime.db);
		const note = await content.create({ type: "notes", slug: "note", data: {} });
		const page = await content.findById("pages", created.entryId);
		const noteGroup = note.translationGroup;
		const pageGroup = page?.translationGroup;
		if (!noteGroup || !pageGroup) throw new Error("entries have no translation group");
		const relations = new RelationRepository(runtime.db);
		const pageIsParent = side.startsWith("parent");
		const relation = await relations.create({
			slug: pageIsParent ? "pages_notes" : "notes_pages",
			parentCollection: pageIsParent ? "pages" : "notes",
			childCollection: pageIsParent ? "notes" : "pages",
			parentLabel: pageIsParent ? "Page" : "Note",
			childLabel: pageIsParent ? "Note" : "Page",
		});
		await writeReferenceSelection(
			runtime.db,
			side === "child"
				? { relation: relation.id, side: "parent", entryGroup: noteGroup, groups: [pageGroup] }
				: side === "child with an unchanged empty set of parents"
					? { relation: relation.id, side: "child", entryGroup: pageGroup, groups: [] }
					: {
							relation: relation.id,
							side: "parent",
							entryGroup: pageGroup,
							groups: side === "parent with a child" ? [noteGroup] : [],
						},
		);
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
	});

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

	it("can revoke authority even when an unrelated collection is unavailable", async () => {
		await new SchemaRegistry(runtime.db).createCollection({ slug: "gone", label: "Gone" });
		await sql`DROP TABLE ec_gone`.execute(runtime.db);
		expect((await runtime.getImportSyncCapability()).available).toBe(false);
		const revoked = await runtime.handleImportSyncGrantRevoke({ id: initial.grant.id }, actor);
		expect(revoked).toMatchObject({ success: true, data: { generation: 2, revoked: true } });
	});

	it("requires an administrator for grant lifecycle and makes double revoke idempotent", async () => {
		const grantRequest = {
			sourceSite: initial.source.site,
			bindingId: "binding-2",
			actorId: actor.id,
		};
		const deniedActor = { id: "subscriber", role: Role.SUBSCRIBER };
		expect(await runtime.handleImportSyncGrantCreate(grantRequest, deniedActor)).toMatchObject({
			success: false,
			error: { code: "FORBIDDEN" },
		});
		expect(
			await runtime.handleImportSyncGrantRevoke({ id: initial.grant.id }, deniedActor),
		).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
		expect((await new ImportSyncGrantRepository(runtime.db).find(initial.grant.id))?.revoked).toBe(
			false,
		);
		const created = await runtime.handleImportSyncGrantCreate(grantRequest, actor);
		if (!created.success) throw new Error("Grant was not created");
		expect(created.data).toMatchObject({ ...grantRequest, generation: 1, revoked: false });
		const revoked = await runtime.handleImportSyncGrantRevoke({ id: created.data.id }, actor);
		expect(revoked).toMatchObject({ success: true, data: { generation: 2, revoked: true } });
		expect(await runtime.handleImportSyncGrantRevoke({ id: created.data.id }, actor)).toEqual(
			revoked,
		);
		const request = {
			...initial,
			grant: {
				id: created.data.id,
				bindingId: created.data.bindingId,
				generation: created.data.generation,
			},
		};
		expect(await runtime.handleImportSync(request, actor)).toEqual({
			success: true,
			data: { state: "conflict", reason: "import_grant_changed" },
		});
		expect(saves).toBe(0);
	});

	it.each(["missing", "generation", "binding", "source", "actor", "revoked"])(
		"refuses %s grant evidence before save hooks",
		async (mismatch) => {
			const request = structuredClone(initial);
			let caller = actor;
			if (mismatch === "missing") request.grant.id = "missing-grant";
			if (mismatch === "generation") request.grant.generation++;
			if (mismatch === "binding") request.grant.bindingId = "other-binding";
			if (mismatch === "source") request.source.site = "https://other.example";
			if (mismatch === "actor") caller = { ...actor, id: "other-admin" };
			if (mismatch === "revoked")
				await new ImportSyncGrantRepository(runtime.db).revoke(request.grant.id);
			const result = await runtime.handleImportSync(request, caller);
			expect(result).toEqual({
				success: true,
				data: { state: "conflict", reason: "import_grant_changed" },
			});
			expect(saves).toBe(0);
			expect(await runtime.db.selectFrom("revisions").select("id").execute()).toHaveLength(0);
			expect(
				await runtime.db.selectFrom("_emdash_import_operations").select("operation_id").execute(),
			).toHaveLength(0);
		},
	);

	it("declines collections without revision support before save hooks", async () => {
		await new SchemaRegistry(runtime.db).createCollection({
			slug: "plain",
			label: "Plain",
			supports: [],
		});
		expect(await runtime.getImportSyncCapability("plain")).toEqual({
			version: 1,
			available: false,
			mappedFieldsOnly: true,
			grantGenerationFence: true,
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
