/**
 * Item 132: Atomic per-post WXR import proof on real Cloudflare D1 `.batch()` in workerd.
 *
 * Covers every atomic guarantee on real D1:
 * - One D1.batch() commits content + bylines + SEO + taxonomy pivots + schedule +
 *   mutable group baseline + immutable finished receipt (and NO accidental initial revision).
 * - Forced SQL assertion failure rolls everything back (zero orphans in any table).
 * - Lost committed D1 reply recovers cleanly via replay with ZERO writes & historic hashes.
 * - Collection remap and input fingerprint mismatch refuse as conflict with ZERO writes.
 * - Legacy/owner slug hit without a receipt skips with ZERO writes (no SEO fill).
 * - Unreceipted anchor refuses translation with ZERO writes.
 * - Multilingual 3-locale progression advances mutable group baseline generation so the
 *   3rd locale succeeds after authorized group term changes.
 * - Owner edits to anchor content, anchor SEO, group terms, or a sibling refuse later
 *   translation writes with ZERO writes.
 * - Boundary load: >30 taxonomy pivots split across statements in ONE D1 batch (<= 100 binds);
 *   oversize (>2 MB value) rejected cleanly with ZERO fallback writes.
 * - Unproven D1 adapter without atomic batch or real transactions refuses with ZERO writes.
 */

import { env } from "cloudflare:test";
import { Kysely, SqliteAdapter, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import {
	AtomicWxrImportRepository,
	D1_MAX_VALUE_BYTES,
	type AtomicWxrCreateInput,
	type AtomicWxrItemReceipt,
} from "../../src/database/repositories/wxr-atomic-import.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;
let repo: AtomicWxrImportRepository;
let batches: number;
let loseResponse: boolean;
let bylineId: string;
let catGroupA: string;
let catGroupB: string;
let tagGroup1: string;

function makeInput(overrides: Partial<AtomicWxrCreateInput> = {}): AtomicWxrCreateInput {
	return {
		sourceLineage: "install:site-alpha",
		sourcePostId: "101",
		collection: "posts",
		slug: "hello-world",
		locale: "en",
		status: "published",
		data: { title: "Hello World", content: "[]" },
		bylines: [{ bylineId }],
		seo: { title: "SEO Hello", description: "Desc Hello" },
		hasSeo: true,
		terms: [
			{ taxonomy: "category", termGroup: catGroupA },
			{ taxonomy: "tag", termGroup: tagGroup1 },
		],
		inputFingerprint: "v1:fp-101-en",
		storedDataHash: "v1:data-101-en",
		...overrides,
	};
}

function requireCreated(
	result: Awaited<ReturnType<AtomicWxrImportRepository["applyCreate"]>>,
): AtomicWxrItemReceipt {
	if (result.outcome !== "created") {
		throw new Error(`Expected created, got ${JSON.stringify(result)}`);
	}
	return result.receipt;
}

async function snapshot() {
	const results = await Promise.all([
		sql`SELECT * FROM ec_posts ORDER BY id`.execute(db),
		sql`SELECT * FROM revisions ORDER BY id`.execute(db),
		sql`SELECT * FROM _emdash_content_bylines ORDER BY id`.execute(db),
		sql`SELECT * FROM _emdash_seo ORDER BY collection, content_id`.execute(db),
		sql`SELECT * FROM content_taxonomies ORDER BY collection, entry_id, taxonomy_id`.execute(db),
		sql`SELECT * FROM _emdash_wxr_import_receipts ORDER BY operation_id`.execute(db),
		sql`SELECT * FROM _emdash_wxr_group_baselines ORDER BY collection, translation_group`.execute(
			db,
		),
	]);
	return results.map((r) => r.rows);
}

beforeAll(() => {
	const counted = new Proxy(env.DB, {
		get(target, property) {
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					batches++;
					const results = await target.batch(statements);
					if (loseResponse) {
						loseResponse = false;
						throw new Error("lost response after D1 commit");
					}
					return results;
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: counted }) });
	repo = new AtomicWxrImportRepository(db);
});

beforeEach(async () => {
	loseResponse = false;
	await resetD1Schema(db);
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "posts", label: "Posts", hasSeo: true });
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
	await registry.createField("posts", { slug: "content", label: "Content", type: "string" });
	await registry.createCollection({ slug: "pages", label: "Pages", hasSeo: true });
	await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
	await registry.createField("pages", { slug: "content", label: "Content", type: "string" });

	const bylineRepo = new BylineRepository(db);
	const createdByline = await bylineRepo.create({
		slug: "alice",
		displayName: "Alice Author",
		isGuest: true,
	});
	bylineId = createdByline.id;

	const taxRepo = new TaxonomyRepository(db);
	const catA = await taxRepo.create({ name: "category", slug: "news", label: "News" });
	const catB = await taxRepo.create({ name: "category", slug: "updates", label: "Updates" });
	const tag1 = await taxRepo.create({ name: "tag", slug: "featured", label: "Featured" });
	catGroupA = catA.translationGroup ?? catA.id;
	catGroupB = catB.translationGroup ?? catB.id;
	tagGroup1 = tag1.translationGroup ?? tag1.id;
	batches = 0;
});

afterAll(async () => {
	await db.destroy();
});

describe("atomic per-post WXR import on real D1 .batch()", () => {
	it("commits content, bylines, SEO, taxonomy pivots, schedule, baseline, and receipt in ONE batch with no initial revision", async () => {
		const scheduledAt = "2030-06-01T12:00:00.000Z";
		const receipt = requireCreated(
			await repo.applyCreate(
				makeInput({
					status: "scheduled",
					scheduledAt,
				}),
			),
		);
		expect(batches).toBe(1);
		expect(receipt.status).toBe("scheduled");
		expect(receipt.storedDataHash).toBe("v1:data-101-en");
		expect(receipt.committedHash).toMatch(/^[0-9a-f]{64}$/);

		const rows = (await sql`SELECT * FROM ec_posts WHERE id = ${receipt.id}`.execute(db)).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: receipt.id,
			slug: "hello-world",
			status: "scheduled",
			scheduled_at: scheduledAt,
			version: 1,
		});
		expect((await sql`SELECT * FROM revisions`.execute(db)).rows).toHaveLength(0);
		expect((await sql`SELECT * FROM _emdash_content_bylines`.execute(db)).rows).toHaveLength(1);
		expect((await sql`SELECT * FROM _emdash_seo`.execute(db)).rows).toHaveLength(1);
		expect((await sql`SELECT * FROM content_taxonomies`.execute(db)).rows).toHaveLength(2);
		expect((await sql`SELECT * FROM _emdash_wxr_import_receipts`.execute(db)).rows).toHaveLength(1);
		expect((await sql`SELECT * FROM _emdash_wxr_group_baselines`.execute(db)).rows).toHaveLength(1);
	});

	it("rolls back all writes when the final SQL assertion fails (zero orphans)", async () => {
		const before = await snapshot();
		const res = await repo.applyCreate(makeInput({ _forceAssertionFailure: true }));
		expect(res.outcome).toBe("conflict");
		expect(await snapshot()).toEqual(before);
	});

	it("recovers a lost committed D1 response via replay with ZERO writes and historic hashes", async () => {
		loseResponse = true;
		const res = await repo.applyCreate(makeInput());
		// The batch committed before the simulated transport drop, so the catch block's
		// raced-receipt check already observes the durable finished receipt as a replay.
		expect(res.outcome).toBe("replayed");
		expect(batches).toBe(1);
		const afterCommit = await snapshot();

		const replay = await repo.applyCreate(makeInput());
		expect(replay.outcome).toBe("replayed");
		if (replay.outcome === "replayed" && res.outcome === "replayed") {
			expect(replay.receipt.operationId).toBe(res.receipt.operationId);
			expect(replay.receipt.storedDataHash).toBe("v1:data-101-en");
			expect(replay.receipt.committedHash).toBe(res.receipt.committedHash);
		}
		expect(batches).toBe(1);
		expect(await snapshot()).toEqual(afterCommit);
	});

	it("refuses destination collection remap and fingerprint mismatch as conflict with ZERO writes", async () => {
		requireCreated(await repo.applyCreate(makeInput()));
		const before = await snapshot();

		const remapped = await repo.applyCreate(makeInput({ collection: "pages" }));
		expect(remapped.outcome).toBe("conflict");

		const changed = await repo.applyCreate(makeInput({ inputFingerprint: "v1:different" }));
		expect(changed.outcome).toBe("conflict");

		expect(batches).toBe(1);
		expect(await snapshot()).toEqual(before);
	});

	it("skips a pre-existing unreceipted slug with ZERO writes (no SEO fill) and refuses translation onto it", async () => {
		const contentRepo = new ContentRepository(db);
		const legacy = await contentRepo.create({
			type: "posts",
			slug: "hello-world",
			locale: "en",
			status: "published",
			data: { title: "Existing Owner Post", content: "[]" },
		});
		const before = await snapshot();

		const skipped = await repo.applyCreate(makeInput());
		expect(skipped).toMatchObject({ outcome: "skipped", existingId: legacy.id });
		expect(await snapshot()).toEqual(before);

		const refusedTranslation = await repo.applyCreate(
			makeInput({
				sourcePostId: "102",
				locale: "fr",
				slug: "bonjour-monde",
				translationOf: legacy.id,
				inputFingerprint: "v1:fp-102-fr",
				storedDataHash: "v1:data-102-fr",
			}),
		);
		expect(refusedTranslation.outcome).toBe("conflict");
		expect(await snapshot()).toEqual(before);
	});

	it("advances mutable group baseline across 2nd and 3rd locales after authorized group changes", async () => {
		const anchor = requireCreated(await repo.applyCreate(makeInput()));

		const fr = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "102",
					locale: "fr",
					slug: "bonjour-monde",
					translationOf: anchor.id,
					terms: [{ taxonomy: "category", termGroup: catGroupB }],
					replaceTaxonomies: ["category"],
					inputFingerprint: "v1:fp-102-fr",
					storedDataHash: "v1:data-102-fr",
				}),
			),
		);
		expect(fr.translationGroup).toBe(anchor.translationGroup);

		// 3rd locale succeeds against generation 2 baseline (category=B, tag=1).
		const es = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "103",
					locale: "es",
					slug: "hola-mundo",
					translationOf: anchor.id,
					terms: [{ taxonomy: "category", termGroup: catGroupA }],
					replaceTaxonomies: ["category"],
					inputFingerprint: "v1:fp-103-es",
					storedDataHash: "v1:data-103-es",
				}),
			),
		);
		expect(es.translationGroup).toBe(anchor.translationGroup);

		const baseline = (
			await sql<{ generation: number }>`
				SELECT generation FROM _emdash_wxr_group_baselines
				WHERE collection = 'posts' AND translation_group = ${anchor.translationGroup}
			`.execute(db)
		).rows[0];
		expect(baseline?.generation).toBe(3);
	});

	it.each(["anchor content", "anchor SEO", "group terms", "sibling content"] as const)(
		"refuses later translation with ZERO writes after owner edits %s",
		async (editKind) => {
			const anchor = requireCreated(await repo.applyCreate(makeInput()));
			const fr = requireCreated(
				await repo.applyCreate(
					makeInput({
						sourcePostId: "102",
						locale: "fr",
						slug: "bonjour-monde",
						translationOf: anchor.id,
						terms: [],
						replaceTaxonomies: [],
						inputFingerprint: "v1:fp-102-fr",
						storedDataHash: "v1:data-102-fr",
					}),
				),
			);

			if (editKind === "anchor content") {
				await new ContentRepository(db).update("posts", anchor.id, {
					data: { title: "Owner Edited Anchor", content: "[]" },
				});
			} else if (editKind === "anchor SEO") {
				await new SeoRepository(db).upsert("posts", anchor.id, {
					title: "Owner Edited SEO",
				});
			} else if (editKind === "group terms") {
				await new TaxonomyRepository(db).setTermsForEntry("posts", anchor.id, "category", [
					catGroupB,
				]);
			} else {
				await new ContentRepository(db).update("posts", fr.id, {
					data: { title: "Owner Edited French Sibling", content: "[]" },
				});
			}

			const before = await snapshot();
			const refused = await repo.applyCreate(
				makeInput({
					sourcePostId: "103",
					locale: "es",
					slug: "hola-mundo",
					translationOf: anchor.id,
					terms: [{ taxonomy: "category", termGroup: catGroupB }],
					replaceTaxonomies: ["category"],
					inputFingerprint: "v1:fp-103-es",
					storedDataHash: "v1:data-103-es",
				}),
			);
			expect(refused.outcome).toBe("conflict");
			expect(await snapshot()).toEqual(before);
		},
	);

	it("splits >30 taxonomy pivots inside ONE D1 batch and rejects >2 MB oversize values with ZERO writes", async () => {
		const taxRepo = new TaxonomyRepository(db);
		const manyTerms: Array<{ taxonomy: string; termGroup: string }> = [];
		for (let i = 0; i < 40; i++) {
			// oxlint-disable-next-line no-await-in-loop -- creating distinct taxonomy terms sequentially
			const t = await taxRepo.create({ name: "tag", slug: `bulk-tag-${i}`, label: `Bulk ${i}` });
			manyTerms.push({ taxonomy: "tag", termGroup: t.translationGroup ?? t.id });
		}
		batches = 0;

		const created = requireCreated(await repo.applyCreate(makeInput({ terms: manyTerms })));
		expect(batches).toBe(1);
		const pivotCount = (
			await sql<{ n: number }>`
				SELECT COUNT(*) AS n FROM content_taxonomies
				WHERE collection = 'posts' AND entry_id = ${created.translationGroup}
			`.execute(db)
		).rows[0]?.n;
		expect(Number(pivotCount)).toBe(40);

		const beforeOversize = await snapshot();
		const huge = "x".repeat(D1_MAX_VALUE_BYTES + 64);
		const oversize = await repo.applyCreate(
			makeInput({
				sourcePostId: "999",
				slug: "too-big",
				data: { title: "Too Big", content: huge },
				inputFingerprint: "v1:fp-999",
				storedDataHash: "v1:data-999",
			}),
		);
		expect(oversize).toMatchObject({ outcome: "error", code: "D1_LIMIT_EXCEEDED" });
		expect(batches).toBe(1);
		expect(await snapshot()).toEqual(beforeOversize);
	});

	it("refuses a D1 driver without atomic batch support instead of falling back to sequential writes", async () => {
		class UnprovenD1Dialect extends RawBindingD1Dialect {
			override createAdapter(): SqliteAdapter {
				return new SqliteAdapter();
			}
		}
		const unproven = new Kysely<Database>({ dialect: new UnprovenD1Dialect({ database: env.DB }) });
		try {
			const before = await snapshot();
			const res = await new AtomicWxrImportRepository(unproven).applyCreate(makeInput());
			expect(res.outcome).toBe("error");
			expect(await snapshot()).toEqual(before);
		} finally {
			await unproven.destroy();
		}
	});
});
