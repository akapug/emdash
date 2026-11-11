import { sql, type Kysely } from "kysely";
import { expect, it } from "vitest";

import {
	hasImportBaselineTriggers,
	importBaselineTriggerWitness,
	markImportBaselineCustomerOwned,
} from "../../src/database/import-baseline-triggers.js";
import { up } from "../../src/database/migrations/088_import_baselines.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

export async function seedImportBaseline(db: Kysely<Database>): Promise<void> {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts" });
	await registry.createCollection({ slug: "page", label: "Pages" });
	await sql`INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group)
		VALUES ('byline-row', 'writer', 'Writer', 'en', 'byline-group')`.execute(db);
	await sql`INSERT INTO taxonomies (id, name, slug, label, locale, translation_group)
		VALUES ('term-row', 'category', 'news', 'News', 'en', 'term-group')`.execute(db);
	await sql`INSERT INTO _emdash_byline_fields (id, slug, label, type, translatable)
		VALUES ('field', 'caption', 'Caption', 'string', 1)`.execute(db);
	await sql`INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
		VALUES ('byline-row', 'field', '"Caption"')`.execute(db);
	await sql`INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
		VALUES ('byline-group', 'field', '"Shared"')`.execute(db);
	await sql`INSERT INTO revisions (id, collection, entry_id, data)
		VALUES ('000-original', 'post', 'entry-en', '{"title":"Original"}')`.execute(db);
	await sql`INSERT INTO ec_post (id, slug, locale, translation_group, primary_byline_id, live_revision_id)
		VALUES ('entry-en', 'entry', 'en', 'entry-group', 'byline-group', '000-original'),
		('entry-fr', 'entry', 'fr', 'entry-group', NULL, NULL),
		('unrelated', 'unrelated', 'en', 'other-group', NULL, NULL)`.execute(db);
	await sql`INSERT INTO ec_page (id, slug, locale, translation_group)
		VALUES ('entry-en', 'page', 'en', 'page-group')`.execute(db);
	await sql`INSERT INTO _emdash_content_bylines (id, collection_slug, content_id, byline_id, sort_order)
		VALUES ('credit', 'post', 'entry-en', 'byline-group', 0)`.execute(db);
	await sql`INSERT INTO _emdash_seo (collection, content_id, seo_title, seo_no_index)
		VALUES ('post', 'entry-en', 'Title', 0)`.execute(db);
	await sql`INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
		VALUES ('post', 'entry-group', 'term-group')`.execute(db);
	await sql`INSERT INTO _emdash_content_references (id, relation_id, parent_group, child_group)
		VALUES ('edge', 'relation-group', 'entry-group', 'loose-group')`.execute(db);

	for (const [collection, id, locale] of [
		["post", "entry-en", "en"],
		["post", "entry-fr", "fr"],
		["post", "unrelated", "en"],
		["page", "entry-en", "en"],
	] as const) {
		// oxlint-disable-next-line no-await-in-loop -- seed distinct source and destination identities
		await db
			.insertInto("_emdash_import_baselines")
			.values({
				source_site: "https://source.example",
				source_type: collection,
				source_id: id,
				collection,
				entry_id: id,
				locale,
				original_revision_id:
					collection === "post" && id === "entry-en" ? "000-original" : `${collection}-${id}`,
				version: 1,
				live_revision_id: "000-original",
				last_sequence: 1,
				last_operation_id: `${collection}-${id}`,
			})
			.execute();
	}
}

async function ownedEntries(db: Kysely<Database>): Promise<string[]> {
	const rows = await db
		.selectFrom("_emdash_import_baselines")
		.select(["collection", "entry_id"])
		.where("customer_owned", "=", 1)
		.execute();
	return rows.map((row) => `${row.collection}/${row.entry_id}`).toSorted();
}

export function importBaselineCases(getDb: () => Kysely<Database>): void {
	it("requires installed content, related-state and original-pin triggers for capability", async () => {
		const db = getDb();
		expect(await hasImportBaselineTriggers(db, "post")).toBe(true);
		expect(await hasImportBaselineTriggers(db, "missing")).toBe(false);
		await sql`DROP TRIGGER emdash_import_post_seo_update`.execute(db);
		expect(await hasImportBaselineTriggers(db, "post")).toBe(false);
		expect(await hasImportBaselineTriggers(db, "page")).toBe(true);
	});

	it("checks the trigger witness in the mutation statement rather than trusting a successful preflight", async () => {
		const db = getDb();
		expect(await hasImportBaselineTriggers(db, "post")).toBe(true);
		const witness = importBaselineTriggerWitness(db, "post");
		await sql`DROP TRIGGER emdash_import_post_seo_update`.execute(db);
		const result = await sql`UPDATE _emdash_import_baselines SET last_sequence = 2
			WHERE collection = 'post' AND entry_id = 'entry-en' AND ${witness}
			RETURNING entry_id`.execute(db);
		expect(result.rows).toEqual([]);
		const row = await db
			.selectFrom("_emdash_import_baselines")
			.select("last_sequence")
			.where("collection", "=", "post")
			.where("entry_id", "=", "entry-en")
			.executeTakeFirst();
		expect(row?.last_sequence).toBe(1);
	});

	it("does not restore eligibility after repairing an interrupted custody witness", async () => {
		const db = getDb();
		await sql`DROP TRIGGER emdash_import_post_content_update`.execute(db);
		await sql`UPDATE ec_post SET slug = slug WHERE id = 'entry-en'`.execute(db);
		await up(db);
		expect(await hasImportBaselineTriggers(db, "post")).toBe(true);
		expect(await ownedEntries(db)).toEqual(["post/entry-en", "post/entry-fr", "post/unrelated"]);
	});

	it("rejects a same-name trigger with a missing invalidation body", async () => {
		const db = getDb();
		await sql`DROP TRIGGER emdash_import_post_content_update`.execute(db);
		await sql`CREATE TRIGGER emdash_import_post_content_update AFTER UPDATE ON ec_post
			BEGIN SELECT 1; END`.execute(db);
		expect(await hasImportBaselineTriggers(db, "post")).toBe(false);
		await expect(up(db)).rejects.toThrow("does not match the supported schema");
	});

	it("makes identical content saves sticky without affecting another locale or collection", async () => {
		const db = getDb();
		await sql`UPDATE ec_post SET slug = slug WHERE id = 'entry-en'`.execute(db);
		await sql`UPDATE ec_post SET slug = 'temporary' WHERE id = 'entry-en'`.execute(db);
		await sql`UPDATE ec_post SET slug = 'entry' WHERE id = 'entry-en'`.execute(db);
		expect(await ownedEntries(db)).toEqual(["post/entry-en"]);
	});

	it("records a no-op assignment intent for every mapped locale in a translation group", async () => {
		const db = getDb();
		await markImportBaselineCustomerOwned(db, "post", "entry-group", { translationGroup: true });
		expect(await ownedEntries(db)).toEqual(["post/entry-en", "post/entry-fr"]);
		await up(db);
		expect(await ownedEntries(db)).toEqual(["post/entry-en", "post/entry-fr"]);
	});

	it("propagates invalidation failures rather than reporting an unrecorded customer write", async () => {
		const db = getDb();
		await sql`CREATE TRIGGER baseline_failure BEFORE UPDATE ON _emdash_import_baselines
			BEGIN SELECT RAISE(ABORT, 'baseline write failed'); END`.execute(db);
		await expect(markImportBaselineCustomerOwned(db, "post", "entry-en")).rejects.toThrow(
			"baseline write failed",
		);
	});

	it("records row-specific intent without taking custody of unprovable content", async () => {
		const db = getDb();
		await markImportBaselineCustomerOwned(db, "post", "entry-en");
		await markImportBaselineCustomerOwned(db, "post", "never-imported");
		expect(await ownedEntries(db)).toEqual(["post/entry-en"]);
		expect(await db.selectFrom("_emdash_import_baselines").selectAll().execute()).toHaveLength(4);
	});

	it("leaves a sticky baseline tombstone after content deletion", async () => {
		const db = getDb();
		await sql`DELETE FROM ec_post WHERE id = 'entry-en'`.execute(db);
		expect(await ownedEntries(db)).toEqual(["post/entry-en"]);
		expect(
			await db
				.selectFrom("_emdash_import_baselines")
				.selectAll()
				.where("entry_id", "=", "entry-en")
				.where("collection", "=", "post")
				.executeTakeFirst(),
		).toBeDefined();
	});

	const singleEntryWrites = [
		[
			"SEO identical update",
			sql`UPDATE _emdash_seo SET seo_title = seo_title WHERE content_id = 'entry-en'`,
		],
		["SEO delete", sql`DELETE FROM _emdash_seo WHERE content_id = 'entry-en'`],
		[
			"SEO insert",
			sql`INSERT INTO _emdash_seo (collection, content_id, seo_no_index) VALUES ('post', 'unrelated', 0)`,
		],
		[
			"byline assignment identical update",
			sql`UPDATE _emdash_content_bylines SET sort_order = sort_order WHERE id = 'credit'`,
		],
		["byline assignment delete", sql`DELETE FROM _emdash_content_bylines WHERE id = 'credit'`],
		[
			"byline assignment insert",
			sql`INSERT INTO _emdash_content_bylines (id, collection_slug, content_id, byline_id, sort_order) VALUES ('new-credit', 'post', 'unrelated', 'byline-group', 0)`,
		],
		["byline identical update", sql`UPDATE _emdash_bylines SET bio = bio WHERE id = 'byline-row'`],
		["byline delete", sql`DELETE FROM _emdash_bylines WHERE id = 'byline-row'`],
		[
			"byline translation",
			sql`INSERT INTO _emdash_bylines (id, slug, display_name, locale, translation_group) VALUES ('byline-fr', 'writer', 'Writer', 'fr', 'byline-group')`,
		],
		[
			"byline field identical update",
			sql`UPDATE _emdash_byline_field_values SET value = value WHERE byline_id = 'byline-row'`,
		],
		[
			"byline field delete",
			sql`DELETE FROM _emdash_byline_field_values WHERE byline_id = 'byline-row'`,
		],
		[
			"shared byline field identical update",
			sql`UPDATE _emdash_byline_field_group_values SET value = value WHERE translation_group = 'byline-group'`,
		],
		[
			"shared byline field delete",
			sql`DELETE FROM _emdash_byline_field_group_values WHERE translation_group = 'byline-group'`,
		],
	] as const;
	it.each(singleEntryWrites)(
		"invalidates %s independently of content writes",
		async (name, statement) => {
			const db = getDb();
			await statement.execute(db);
			expect(await ownedEntries(db)).toEqual([
				name.endsWith("insert") ? "post/unrelated" : "post/entry-en",
			]);
		},
	);

	const groupWrites = [
		[
			"taxonomy assignment identical update",
			sql`UPDATE content_taxonomies SET taxonomy_id = taxonomy_id WHERE entry_id = 'entry-group'`,
		],
		[
			"taxonomy assignment delete",
			sql`DELETE FROM content_taxonomies WHERE entry_id = 'entry-group'`,
		],
		["term identical update", sql`UPDATE taxonomies SET label = label WHERE id = 'term-row'`],
		["term delete", sql`DELETE FROM taxonomies WHERE id = 'term-row'`],
		[
			"reference identical update",
			sql`UPDATE _emdash_content_references SET sort_order = sort_order WHERE id = 'edge'`,
		],
		["reference delete", sql`DELETE FROM _emdash_content_references WHERE id = 'edge'`],
		[
			"reference insert naming the entry as child",
			sql`INSERT INTO _emdash_content_references (id, relation_id, parent_group, child_group) VALUES ('back-edge', 'relation-group', 'loose-group', 'entry-group')`,
		],
		[
			"term translation insert",
			sql`INSERT INTO taxonomies (id, name, slug, label, locale, translation_group) VALUES ('term-fr', 'category', 'news', 'Actualités', 'fr', 'term-group')`,
		],
	] as const;
	it.each(groupWrites)(
		"invalidates both locale rows for %s using translation groups",
		async (_name, statement) => {
			const db = getDb();
			await statement.execute(db);
			expect(await ownedEntries(db)).toEqual(["post/entry-en", "post/entry-fr"]);
		},
	);

	it("invalidates a taxonomy assignment insert by translation group, not row id", async () => {
		const db = getDb();
		await sql`INSERT INTO taxonomies (id, name, slug, label, locale, translation_group)
			VALUES ('second-term', 'category', 'second', 'Second', 'en', 'second-group')`.execute(db);
		await sql`INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
			VALUES ('post', 'entry-group', 'second-group')`.execute(db);
		expect(await ownedEntries(db)).toEqual(["post/entry-en", "post/entry-fr"]);
	});

	it("invalidates both old and new targets when an assignment is moved", async () => {
		const db = getDb();
		await sql`UPDATE _emdash_content_bylines SET content_id = 'unrelated' WHERE id = 'credit'`.execute(
			db,
		);
		expect(await ownedEntries(db)).toEqual(["post/entry-en", "post/unrelated"]);
	});

	it("protects a primary-only byline without a secondary credit row", async () => {
		const db = getDb();
		await sql`DELETE FROM _emdash_content_bylines WHERE id = 'credit'`.execute(db);
		// A fresh producer baseline stands in for an entry created without secondary credits.
		await db
			.deleteFrom("_emdash_import_baselines")
			.where("entry_id", "=", "entry-en")
			.where("collection", "=", "post")
			.execute();
		await db
			.insertInto("_emdash_import_baselines")
			.values({
				source_site: "https://source.example",
				source_type: "post",
				source_id: "entry-en",
				collection: "post",
				entry_id: "entry-en",
				locale: "en",
				original_revision_id: "000-original",
				version: 1,
				live_revision_id: "000-original",
				last_sequence: 1,
				last_operation_id: "original",
			})
			.execute();
		await sql`UPDATE _emdash_bylines SET display_name = display_name WHERE id = 'byline-row'`.execute(
			db,
		);
		expect(await ownedEntries(db)).toEqual(["post/entry-en"]);
	});

	it("prunes later history normally while retaining the original beyond fifty revisions", async () => {
		const db = getDb();
		const revisions = new RevisionRepository(db);
		for (let index = 1; index <= 55; index++) {
			// oxlint-disable-next-line no-await-in-loop -- exercise retention with more than the default history limit
			await db
				.insertInto("revisions")
				.values({
					id: String(index).padStart(3, "0"),
					collection: "post",
					entry_id: "entry-en",
					data: JSON.stringify({ title: `Later ${index}` }),
					author_id: null,
				})
				.execute();
		}
		await sql`UPDATE ec_post SET live_revision_id = '055' WHERE id = 'entry-en'`.execute(db);
		expect(await revisions.pruneOldRevisions("post", "entry-en", 50)).toBe(5);
		expect((await revisions.findById("000-original"))?.data).toEqual({ title: "Original" });
		expect(await revisions.findById("001")).toBeNull();
		expect(await revisions.countByEntry("post", "entry-en")).toBe(51);
	});

	it.each([
		["customer-owned importer queue", true, "importer", 0],
		["importer queue whose customer edit races the prune snapshot", false, "importer-raced", 0],
		["untouched importer queue", false, "importer", 2],
		["customer-owned editor queue", true, "editor", 2],
		["customer-owned unrelated-source receipt", true, "other-source", 2],
	] as const)(
		"drains %s without widening importer custody retention",
		async (_name, customerOwned, origin, expectedPruned) => {
			const db = getDb();
			for (const id of ["001", "002", "003"]) {
				// oxlint-disable-next-line no-await-in-loop -- ordered history supplies a bounded queued prune
				await db
					.insertInto("revisions")
					.values({ id, collection: "post", entry_id: "entry-en", data: "{}", author_id: null })
					.execute();
			}
			if (origin !== "editor") {
				await db
					.insertInto("_emdash_import_operations")
					.values({
						operation_id: "queued-import",
						source_site:
							origin === "other-source" ? "https://other.example" : "https://source.example",
						source_type: "post",
						source_id: "entry-en",
						collection: "post",
						entry_id: "entry-en",
						locale: "en",
						sequence: 2,
						request_hash: "queued-request",
						revision_id: "003",
						version: 2,
						completed: 1,
					})
					.execute();
			}
			if (customerOwned) await markImportBaselineCustomerOwned(db, "post", "entry-en");
			const revisions = new RevisionRepository(db);
			await revisions.queuePruning("post", "entry-en", "003");
			let customerEditPending = origin === "importer-raced";
			const pruning = new RevisionRepository(
				db.withPlugin({
					transformQuery(args) {
						return args.node;
					},
					async transformResult(args) {
						if (customerEditPending) {
							customerEditPending = false;
							await markImportBaselineCustomerOwned(db, "post", "entry-en");
						}
						return args.result;
					},
				}),
			);
			expect(await pruning.pruneQueuedEntry("post", "entry-en", "003", 1)).toBe(expectedPruned);
			expect(await revisions.countByEntry("post", "entry-en")).toBe(4 - expectedPruned);
			expect((await revisions.findById("000-original"))?.data).toEqual({ title: "Original" });
			expect(
				await db
					.selectFrom("_emdash_revision_prune_queue")
					.selectAll()
					.where("collection", "=", "post")
					.where("entry_id", "=", "entry-en")
					.execute(),
			).toEqual([]);
		},
	);

	it("refuses original snapshot deletion through cleanup and direct SQL", async () => {
		const db = getDb();
		const revisions = new RevisionRepository(db);
		await sql`UPDATE ec_post SET live_revision_id = NULL WHERE id = 'entry-en'`.execute(db);
		expect(await revisions.deleteIfUnreferenced("post", "entry-en", "000-original")).toBe(false);
		await sql`DELETE FROM revisions WHERE id = '000-original'`.execute(db);
		expect(await revisions.findById("000-original")).not.toBeNull();
		await db
			.insertInto("revisions")
			.values({
				id: "later",
				collection: "post",
				entry_id: "entry-en",
				data: "{}",
				author_id: null,
			})
			.execute();
		await sql`DELETE FROM ec_post WHERE id = 'entry-en'`.execute(db);
		expect(await revisions.deleteByEntry("post", "entry-en")).toBe(1);
		expect(await revisions.findById("later")).toBeNull();
		expect((await revisions.findById("000-original"))?.data).toEqual({ title: "Original" });
	});

	it("drops collection-specific shared-table triggers without losing original pins", async () => {
		const db = getDb();
		await new SchemaRegistry(db).deleteCollection("post", { force: true });
		expect(await hasImportBaselineTriggers(db, "post")).toBe(false);
		await sql`UPDATE _emdash_bylines SET display_name = 'After deletion' WHERE id = 'byline-row'`.execute(
			db,
		);
		expect(await ownedEntries(db)).toEqual(["post/entry-en", "post/entry-fr", "post/unrelated"]);
		await sql`DELETE FROM revisions WHERE id = '000-original'`.execute(db);
		expect(await new RevisionRepository(db).findById("000-original")).not.toBeNull();
	});
}
