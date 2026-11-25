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
import { Kysely, PostgresAdapter, SqliteAdapter, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { createPasswordVerifier } from "../../src/content/protection.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import {
	AtomicWxrImportRepository,
	computeStoredDataHash,
	D1_MAX_VALUE_BYTES,
	supportsAtomicWxrImport,
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
		sourceGroupId: "wp-trid-1",
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
	await registry.createField("posts", { slug: "event_at", label: "Event At", type: "datetime" });
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
		expect(receipt.storedDataHash).toBe(
			await computeStoredDataHash({ title: "Hello World", content: "[]" }),
		);
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
			expect(replay.receipt.storedDataHash).toBe(res.receipt.storedDataHash);
			expect(replay.receipt.committedHash).toBe(res.receipt.committedHash);
		}
		expect(batches).toBe(1);
		expect(await snapshot()).toEqual(afterCommit);
	});

	it("classifies collection remap as conflict and changed fingerprint as changed with ZERO writes", async () => {
		requireCreated(await repo.applyCreate(makeInput()));
		const before = await snapshot();

		const remapped = await repo.applyCreate(makeInput({ collection: "pages" }));
		expect(remapped.outcome).toBe("conflict");

		const changed = await repo.applyCreate(makeInput({ inputFingerprint: "v1:different" }));
		expect(changed.outcome).toBe("changed");

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

	it.each([
		"anchor content",
		"anchor SEO",
		"group terms",
		"sibling content",
		"sibling SEO delete",
	] as const)(
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
			} else if (editKind === "sibling SEO delete") {
				await sql`DELETE FROM _emdash_seo WHERE collection = 'posts' AND content_id = ${fr.id}`.execute(
					db,
				);
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
				}),
			);
			expect(refused.outcome).toBe("conflict");
			expect(await snapshot()).toEqual(before);
		},
	);

	it("refuses translation after protected SEO edit, wrong sourceGroupId, or interleaved term/byline delete", async () => {
		const verifier = await createPasswordVerifier("secret-pass");
		const protectedAnchor = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "201",
					sourceGroupId: "wp-trid-prot",
					slug: "protected-post",
					protection: { version: 1, mode: "password", verifier },
					seo: { title: "Protected SEO" },
					inputFingerprint: "v1:fp-201-en",
				}),
			),
		);
		// Wrong sourceGroupId on the SAME lineage must be refused.
		const beforeWrongGroup = await snapshot();
		const wrongGroup = await repo.applyCreate(
			makeInput({
				sourcePostId: "202",
				sourceGroupId: "wp-trid-OTHER",
				slug: "protected-post-fr",
				locale: "fr",
				translationOf: protectedAnchor.id,
				inputFingerprint: "v1:fp-202-fr",
			}),
		);
		expect(wrongGroup.outcome).toBe("conflict");
		expect(await snapshot()).toEqual(beforeWrongGroup);

		// Edit protected SEO directly -> later translation must be refused with ZERO writes.
		await sql`UPDATE _emdash_protected_content SET seo = '{"title":"Owner Edited"}' WHERE collection = 'posts' AND content_id = ${protectedAnchor.id}`.execute(
			db,
		);
		const beforeProtEdit = await snapshot();
		const refusedProt = await repo.applyCreate(
			makeInput({
				sourcePostId: "202",
				sourceGroupId: "wp-trid-prot",
				slug: "protected-post-fr",
				locale: "fr",
				translationOf: protectedAnchor.id,
				inputFingerprint: "v1:fp-202-fr",
			}),
		);
		expect(refusedProt.outcome).toBe("conflict");
		expect(await snapshot()).toEqual(beforeProtEdit);

		// Interleaved term deletion right before commit -> batch rolls back with ZERO orphans.
		const taxRepo = new TaxonomyRepository(db);
		const tempTerm = await taxRepo.create({ name: "tag", slug: "ephemeral", label: "Ephemeral" });
		const tempGroup = tempTerm.translationGroup ?? tempTerm.id;
		const res = await repo.applyCreate(
			makeInput({
				sourcePostId: "203",
				slug: "interleaved-term-delete",
				terms: [{ taxonomy: "tag", termGroup: tempGroup }],
				inputFingerprint: "v1:fp-203",
				_beforeCommit: async () => {
					await sql`DELETE FROM taxonomies WHERE id = ${tempTerm.id}`.execute(db);
				},
			}),
		);
		expect(res.outcome).toBe("conflict");
		expect(
			(await sql`SELECT * FROM ec_posts WHERE slug = 'interleaved-term-delete'`.execute(db)).rows,
		).toHaveLength(0);
	});

	it("chunks 15 inherited byline credits under D1's 100-bind limit and binds storedDataHash to normalized UTC datetime", async () => {
		const bylineRepo = new BylineRepository(db);
		const fifteenBylines: Array<{ bylineId: string }> = [];
		for (let i = 0; i < 15; i++) {
			// oxlint-disable-next-line no-await-in-loop -- creating 15 distinct bylines sequentially
			const b = await bylineRepo.create({
				slug: `coauthor-${i}`,
				displayName: `Coauthor ${i}`,
				isGuest: true,
			});
			fifteenBylines.push({ bylineId: b.id });
		}
		batches = 0;

		const anchor = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "301",
					sourceGroupId: "wp-trid-15",
					slug: "fifteen-credits",
					data: {
						title: "Fifteen Credits",
						content: "[]",
						event_at: "2026-05-01T14:30:00+02:00",
					},
					bylines: fifteenBylines,
					inputFingerprint: "v1:fp-301-en",
				}),
			),
		);
		expect(batches).toBe(1);
		// Verify storedDataHash matches the post-normalization UTC datetime stored in ec_posts.
		const storedRow = (
			await sql<{
				event_at: string;
			}>`SELECT event_at FROM ec_posts WHERE id = ${anchor.id}`.execute(db)
		).rows[0];
		expect(storedRow?.event_at).toBe("2026-05-01T12:30:00.000Z");
		expect(anchor.storedDataHash).toBe(
			await computeStoredDataHash({
				title: "Fifteen Credits",
				content: "[]",
				event_at: "2026-05-01T12:30:00.000Z",
			}),
		);

		// Translation inherits all 15 credits without explicit bylines -> chunked cleanly in 1 batch!
		const tr = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "302",
					sourceGroupId: "wp-trid-15",
					slug: "quinze-credits",
					locale: "fr",
					translationOf: anchor.id,
					bylines: undefined,
					terms: [],
					replaceTaxonomies: [],
					inputFingerprint: "v1:fp-302-fr",
				}),
			),
		);
		expect(batches).toBe(2);
		const copied = (
			await sql`SELECT * FROM _emdash_content_bylines WHERE collection_slug = 'posts' AND content_id = ${tr.id}`.execute(
				db,
			)
		).rows;
		expect(copied).toHaveLength(15);
	});

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

		// PostgreSQL adapter is also refused until a dedicated two-session concurrency proof exists.
		class MockPgDialect extends RawBindingD1Dialect {
			override createAdapter(): PostgresAdapter {
				return new PostgresAdapter();
			}
		}
		const pgDb = new Kysely<Database>({ dialect: new MockPgDialect({ database: env.DB }) });
		try {
			expect(supportsAtomicWxrImport(pgDb)).toBe(false);
		} finally {
			await pgDb.destroy();
		}
	});

	it("commits pendingTerms + pendingGuestByline + pendingComments in ONE D1 batch and rolls ALL back on failure", async () => {
		const before = await snapshot();
		const termId = "01JZZZZZZZZZZZZZZZZZZZ0001";
		const commentId = "01JZZZZZZZZZZZZZZZZZZZ0002";

		// Forced assertion failure rolls back pending term, guest byline, comment, content, baseline, and receipt.
		const failed = await repo.applyCreate(
			makeInput({
				sourcePostId: "401",
				slug: "all-in-one",
				bylines: undefined,
				pendingGuestByline: { slug: "guest-atomic", displayName: "Guest Atomic" },
				pendingTerms: [
					{
						id: termId,
						name: "category",
						slug: "in-batch-cat",
						label: "In Batch Cat",
						locale: "en",
						translationGroup: termId,
					},
				],
				terms: [{ taxonomy: "category", termGroup: termId }],
				pendingComments: [
					{
						id: commentId,
						parentId: null,
						authorName: "Commenter",
						authorEmail: "c@example.org",
						body: "Atomic comment",
						status: "approved",
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
				_forceAssertionFailure: true,
			}),
		);
		expect(failed.outcome).toBe("conflict");
		expect(await snapshot()).toEqual(before);
		expect(
			(await sql`SELECT * FROM taxonomies WHERE id = ${termId}`.execute(db)).rows,
		).toHaveLength(0);
		expect(
			(await sql`SELECT * FROM _emdash_bylines WHERE slug = 'guest-atomic'`.execute(db)).rows,
		).toHaveLength(0);
		expect(
			(await sql`SELECT * FROM _emdash_comments WHERE id = ${commentId}`.execute(db)).rows,
		).toHaveLength(0);

		// Now commit cleanly in ONE D1 batch.
		batches = 0;
		const created = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "401",
					slug: "all-in-one",
					bylines: undefined,
					pendingGuestByline: { slug: "guest-atomic", displayName: "Guest Atomic" },
					pendingTerms: [
						{
							id: termId,
							name: "category",
							slug: "in-batch-cat",
							label: "In Batch Cat",
							locale: "en",
							translationGroup: termId,
						},
					],
					terms: [{ taxonomy: "category", termGroup: termId }],
					pendingComments: [
						{
							id: commentId,
							parentId: null,
							authorName: "Commenter",
							authorEmail: "c@example.org",
							body: "Atomic comment",
							status: "approved",
							createdAt: "2026-01-01T00:00:00.000Z",
						},
					],
				}),
			),
		);
		expect(batches).toBe(1);
		expect(created.createdBylineId).toBeTruthy();
		expect(
			(await sql`SELECT * FROM taxonomies WHERE id = ${termId}`.execute(db)).rows,
		).toHaveLength(1);
		expect(
			(await sql`SELECT * FROM _emdash_comments WHERE id = ${commentId}`.execute(db)).rows,
		).toHaveLength(1);
	});

	it("requires sourceGroupId on translations, hashes post-inheritance readout, and guards NULL vs empty string", async () => {
		const anchor = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "410",
					sourceGroupId: "trid-410",
					slug: "inherit-anchor",
					data: { title: "Anchor", content: "[]", event_at: null },
					inputFingerprint: "v1:fp-410-en",
				}),
			),
		);

		// Missing sourceGroupId on translation -> refused as conflict.
		const missingGroup = await repo.applyCreate(
			makeInput({
				sourcePostId: "411",
				sourceGroupId: undefined,
				slug: "inherit-fr",
				locale: "fr",
				translationOf: anchor.id,
				inputFingerprint: "v1:fp-411-fr",
			}),
		);
		expect(missingGroup.outcome).toBe("conflict");

		// Concurrent drift from NULL to empty string "" on inherited field -> typed null-safe guard rejects!
		const nullDrift = await repo.applyCreate(
			makeInput({
				sourcePostId: "412",
				sourceGroupId: "trid-410",
				slug: "inherit-de",
				locale: "de",
				translationOf: anchor.id,
				inheritFields: ["event_at"],
				inputFingerprint: "v1:fp-412-de",
				_beforeCommit: async () => {
					await sql`UPDATE ec_posts SET event_at = '' WHERE id = ${anchor.id}`.execute(db);
				},
			}),
		);
		expect(nullDrift.outcome).toBe("conflict");

		// Read the stored translation: the anchor carries an older, noncanonical offset.
		const originalOffset = "2026-06-01T02:00:00+02:00";
		await sql`UPDATE ec_posts SET event_at = ${originalOffset} WHERE id = ${anchor.id}`.execute(db);
		const tr = requireCreated(
			await repo.applyCreate(
				makeInput({
					sourcePostId: "413",
					sourceGroupId: "trid-410",
					slug: "inherit-es",
					locale: "es",
					translationOf: anchor.id,
					data: { title: "Ancla ES", content: "[]" },
					inheritFields: ["event_at"],
					inputFingerprint: "v1:fp-413-es",
				}),
			),
		);
		const stored = await sql<{ title: string; content: string; event_at: string }>`
			SELECT title, content, event_at FROM ec_posts WHERE id = ${tr.id}
		`.execute(db);
		expect(stored.rows[0]).toEqual({
			title: "Ancla ES",
			content: "[]",
			event_at: "2026-06-01T00:00:00.000Z",
		});
		expect(tr.storedDataHash).toBe(await computeStoredDataHash(stored.rows[0]!));
	});

	it("rolls back when a pending mirror's exact source term disappears", async () => {
		const term = await db
			.selectFrom("taxonomies")
			.selectAll()
			.where("id", "=", catGroupA)
			.executeTakeFirstOrThrow();
		const before = await snapshot();
		const result = await repo.applyCreate(
			makeInput({
				terms: [{ taxonomy: "category", termGroup: catGroupA }],
				expectedTerms: [
					{
						id: term.id,
						name: term.name,
						slug: term.slug,
						locale: term.locale,
						translationGroup: term.translation_group,
						parentId: term.parent_id,
						sortOrder: term.sort_order,
					},
				],
				pendingTerms: [
					{
						id: "pending-news-es",
						name: term.name,
						slug: term.slug,
						label: term.label,
						locale: "es",
						translationGroup: catGroupA,
					},
				],
				_beforeCommit: async () => {
					await db.deleteFrom("taxonomies").where("id", "=", term.id).execute();
				},
			}),
		);
		expect(result.outcome).toBe("conflict");
		expect(await snapshot()).toEqual(before);
		expect(
			await db
				.selectFrom("taxonomies")
				.select("id")
				.where("translation_group", "=", catGroupA)
				.execute(),
		).toHaveLength(0);
	});

	it("replans once against a concurrent source-author binding and keeps one credit", async () => {
		const sourceAuthor = { key: "alice", displayName: "Imported Alice" };
		const result = await repo.applyCreate(
			makeInput({
				bylines: undefined,
				sourceAuthor,
				_beforeCommit: async () => {
					requireCreated(
						await repo.applyCreate(
							makeInput({
								bylines: undefined,
								sourceAuthor,
								sourcePostId: "102",
								slug: "other-post",
								inputFingerprint: "v1:fp-102-en",
							}),
						),
					);
				},
			}),
		);
		requireCreated(result);
		const bindings = await db.selectFrom("_emdash_wxr_author_bindings").selectAll().execute();
		expect(bindings).toHaveLength(1);
		const credits = await db.selectFrom("_emdash_content_bylines").select("byline_id").execute();
		expect(credits.map(({ byline_id }) => byline_id)).toEqual([
			bindings[0]?.byline_id,
			bindings[0]?.byline_id,
		]);
	});

	it("commits reusable sections atomically, rolls back on failure, and re-classifies concurrent losers", async () => {
		const before = await snapshot();
		const failed = await repo.applySectionCreate({
			sourceLineage: "install:site-132",
			sourcePostId: "section:901",
			slug: "hero-d1",
			locale: "en",
			title: "Hero D1",
			contentJson: "[]",
			inputFingerprint: "v1:sec-901",
			_forceAssertionFailure: true,
		});
		expect(failed.outcome).toBe("conflict");
		expect(await snapshot()).toEqual(before);
		expect((await sql`SELECT * FROM _emdash_sections`.execute(db)).rows).toHaveLength(0);

		batches = 0;
		const created = requireCreated(
			await repo.applySectionCreate({
				sourceLineage: "install:site-132",
				sourcePostId: "section:901",
				slug: "hero-d1",
				locale: "en",
				title: "Hero D1",
				contentJson: "[]",
				inputFingerprint: "v1:sec-901",
			}),
		);
		expect(batches).toBe(1);
		expect(created.collection).toBe("_emdash_sections");

		// Replay returns replayed with 0 batches.
		const replayed = await repo.applySectionCreate({
			sourceLineage: "install:site-132",
			sourcePostId: "section:901",
			slug: "hero-d1",
			locale: "en",
			title: "Hero D1",
			contentJson: "[]",
			inputFingerprint: "v1:sec-901",
		});
		expect(replayed.outcome).toBe("replayed");
		expect(batches).toBe(1);

		// Concurrent slug loser on section create rolls back and re-classifies as `skipped`.
		const racedSection = await repo.applySectionCreate({
			sourceLineage: "install:site-132",
			sourcePostId: "section:902",
			slug: "raced-hero",
			locale: "en",
			title: "Raced Hero",
			contentJson: "[]",
			inputFingerprint: "v1:sec-902",
			_beforeCommit: async () => {
				await sql`
					INSERT INTO _emdash_sections (id, slug, title, content, source, created_at, updated_at)
					VALUES ('01JZZZZZZZZZZZZZZZZZZZ0902', 'raced-hero', 'Owner Hero', '[]', 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
				`.execute(db);
			},
		});
		expect(racedSection.outcome).toBe("skipped");

		// Concurrent slug loser on post create also rolls back and re-classifies as `skipped`.
		const racedPost = await repo.applyCreate(
			makeInput({
				sourcePostId: "903",
				slug: "raced-post",
				inputFingerprint: "v1:fp-903",
				_beforeCommit: async () => {
					await new ContentRepository(db).create({
						type: "posts",
						slug: "raced-post",
						locale: "en",
						status: "published",
						data: { title: "Owner Post", content: [] },
					});
				},
			}),
		);
		expect(racedPost.outcome).toBe("skipped");
	});
});
