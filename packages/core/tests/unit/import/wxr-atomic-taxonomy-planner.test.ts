import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WxrPost, WxrTag, WxrTerm } from "../../../src/cli/wxr/parser.js";
import type { ExpectedAtomicTerm } from "../../../src/database/repositories/wxr-atomic-import.js";
import type { Database } from "../../../src/database/types.js";
import {
	canonicalSourceTermIdentities,
	loadAtomicTaxonomyStateFromDb,
	planAtomicPostTaxonomies,
	recordCommittedAtomicTerms,
	WxrTaxonomyConflictError,
} from "../../../src/import/wxr-taxonomies.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function post(overrides: Partial<WxrPost>): WxrPost {
	return { postType: "post", categories: [], tags: [], meta: new Map(), ...overrides };
}

function category(overrides: Partial<ExpectedAtomicTerm> = {}): ExpectedAtomicTerm {
	return {
		id: "child-en",
		name: "category",
		slug: "child",
		locale: "en",
		translationGroup: "child-group",
		parentId: "parent-group",
		sortOrder: 7,
		...overrides,
	};
}

const parent = category({
	id: "parent-group",
	slug: "parent",
	translationGroup: "parent-group",
	parentId: null,
	sortOrder: 3,
});

describe("atomic WXR taxonomy planner", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function insertTerms(...rows: ExpectedAtomicTerm[]): Promise<void> {
		await db
			.insertInto("taxonomies")
			.values(
				rows.map(({ id, name, slug, locale, translationGroup, parentId, sortOrder }) => ({
					id,
					name,
					slug,
					label: slug,
					locale,
					translation_group: translationGroup,
					parent_id: parentId,
					sort_order: sortOrder,
				})),
			)
			.execute();
	}

	it("keeps exact reused row evidence separate from pending mirrors", async () => {
		const source = category();
		const sibling = category({ id: "child-ar", locale: "ar" });
		await insertTerms(
			parent,
			source,
			sibling,
			category({ id: "child-it", locale: "it", translationGroup: "unrelated-group" }),
		);
		const state = await loadAtomicTaxonomyStateFromDb(db, [], [], []);
		const item = post({ categories: ["child", "child"] });
		const plan = planAtomicPostTaxonomies(state, "posts", item, "ar", "en", ["fr", "en", "fr"]);

		// SQLite result rows can have a null prototype; check the exact own fields.
		expect(plan.expectedTerms.map((row) => ({ ...row }))).toStrictEqual([source, sibling]);
		expect(plan.pivots).toStrictEqual([{ taxonomy: "category", termGroup: "child-group" }]);
		expect(plan.carriedTaxonomies).toStrictEqual(["category"]);
		expect(plan.pendingTerms).toMatchObject([
			{ locale: "fr", translationGroup: "child-group", parentId: "parent-group", sortOrder: 7 },
		]);
		const savedMirrors = await db
			.selectFrom("taxonomies")
			.select("id")
			.where("locale", "=", "fr")
			.execute();
		expect(savedMirrors).toEqual([]);
		expect(() => planAtomicPostTaxonomies(state, "posts", item, "it", "en")).toThrow(
			WxrTaxonomyConflictError,
		);
	});

	it("snapshots the raw nullable group on a noncanonical source", async () => {
		const source = category({
			id: "child-fr",
			locale: "fr",
			translationGroup: null,
			parentId: null,
		});
		await insertTerms(source);
		const state = await loadAtomicTaxonomyStateFromDb(db, [], [], []);
		const item = post({ categories: ["child"] });
		const plan = planAtomicPostTaxonomies(state, "posts", item, "fr", "en");

		expect(plan.expectedTerms.map((row) => ({ ...row }))).toStrictEqual([source]);
		expect(plan.pivots).toStrictEqual([{ taxonomy: "category", termGroup: "child-fr" }]);
		expect(plan.pendingTerms).toMatchObject([
			{ locale: "en", translationGroup: "child-fr", parentId: null, sortOrder: 7 },
		]);
	});

	it("appends new root groups and witnesses only already committed rows", async () => {
		await insertTerms({ ...parent, locale: "fr" }, category({ sortOrder: 80 }));
		const state = await loadAtomicTaxonomyStateFromDb(db, [], [], []);
		const item = post({ categories: ["first", "second", "first"] });
		const first = planAtomicPostTaxonomies(state, "posts", item, "fr", "en");

		expect(first.expectedTerms).toStrictEqual([]);
		expect(first.pendingTerms).toMatchObject([
			{ slug: "first", locale: "en", parentId: null, sortOrder: 4 },
			{ slug: "first", locale: "fr", parentId: null, sortOrder: 4 },
			{ slug: "second", locale: "en", parentId: null, sortOrder: 5 },
			{ slug: "second", locale: "fr", parentId: null, sortOrder: 5 },
		]);
		expect(first.pivots.map(({ termGroup }) => termGroup)).toEqual(
			first.pendingTerms.filter(({ locale }) => locale === "en").map(({ id }) => id),
		);
		expect(planAtomicPostTaxonomies(state, "posts", item, "fr", "en").expectedTerms).toEqual([]);

		await insertTerms(...first.pendingTerms);
		recordCommittedAtomicTerms(state, first.pendingTerms);
		const next = planAtomicPostTaxonomies(
			state,
			"posts",
			post({ categories: ["first", "third"] }),
			"en",
			"en",
		);
		const [saved] = first.pendingTerms;
		expect(next.expectedTerms).toStrictEqual([
			{
				id: saved.id,
				name: "category",
				slug: "first",
				locale: "en",
				translationGroup: saved.id,
				parentId: null,
				sortOrder: 4,
			},
		]);
		expect(next.pendingTerms).toMatchObject([{ slug: "third", parentId: null, sortOrder: 6 }]);
	});

	it("fingerprints carried header metadata without consulting destination rows", async () => {
		const item = post({
			tags: ["news", "item-label"],
			customTaxonomies: new Map([["language", ["en"]]]),
			taxonomyLabels: new Map([["tag\u0000item-label", "From the item"]]),
		});
		const genericTag: WxrTerm = { id: 1, taxonomy: "post_tag", slug: "news", name: "Header" };
		const unused: WxrTag = { slug: "unassigned", name: "Unassigned" };
		const initial = await loadAtomicTaxonomyStateFromDb(db, [], [unused], [genericTag]);
		const before = canonicalSourceTermIdentities(item, initial.wxrMetaByNameSlug);
		expect(before).toStrictEqual([
			{ taxonomy: "tag", slug: "item-label", label: "From the item" },
			{ taxonomy: "tag", slug: "news", label: "Header" },
		]);

		await insertTerms(category({ id: "saved-tag", name: "tag", slug: "news", parentId: null }));
		const after = await loadAtomicTaxonomyStateFromDb(db, [], [], [genericTag]);
		expect(canonicalSourceTermIdentities(item, after.wxrMetaByNameSlug)).toEqual(before);
		for (const changed of [
			{ ...genericTag, name: "Renamed header" },
			{ ...genericTag, description: "New description" },
		]) {
			const state = await loadAtomicTaxonomyStateFromDb(db, [], [], [changed]);
			expect(canonicalSourceTermIdentities(item, state.wxrMetaByNameSlug)).not.toEqual(before);
		}

		after.collectionsByTaxonomy.set("language", new Set());
		expect(planAtomicPostTaxonomies(after, "products", item, "en", "en")).toEqual({
			pivots: [],
			pendingTerms: [],
			carriedTaxonomies: [],
			expectedTerms: [],
		});
	});
});
