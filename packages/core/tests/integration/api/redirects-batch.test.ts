import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	BATCH_REDIRECTS_CAPABILITY,
	handleRedirectCreate,
	handleRedirectCreateBatch,
} from "../../../src/api/handlers/redirects.js";
import { MAX_REDIRECT_BATCH_SIZE } from "../../../src/api/schemas/redirects.js";
import { IMPORT_CAPABILITIES } from "../../../src/astro/routes/api/import/wordpress/analyze.js";
import { POST as batchPost } from "../../../src/astro/routes/api/redirects/batch.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import * as redirectCache from "../../../src/redirects/cache.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Batch redirect creation (Item 131)", () => {
	let dbBatch: Kysely<Database>;
	let dbSeq: Kysely<Database>;

	beforeEach(async () => {
		dbBatch = await setupTestDatabase();
		dbSeq = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(dbBatch);
		await teardownTestDatabase(dbSeq);
	});

	it("matches sequential handleRedirectCreate per-rule outcomes on a mixed set (new, duplicate, conflicting, invalid, looping, terminal)", async () => {
		// Seed identical pre-existing rows in both DBs:
		// - /existing -> /already-target (for duplicate conflict)
		// - /chain-b -> /chain-a (so /chain-a -> /chain-b forms a loop)
		for (const db of [dbBatch, dbSeq]) {
			const r1 = await handleRedirectCreate(db, {
				source: "/existing",
				destination: "/already-target",
				type: 301,
				groupName: "seed",
			});
			const r2 = await handleRedirectCreate(db, {
				source: "/chain-b",
				destination: "/chain-a",
				type: 301,
				groupName: "seed",
			});
			expect(r1.success && r2.success).toBe(true);
		}

		const mixedRules: unknown[] = [
			{ source: "/new-1", destination: "/pages/new-1", type: 301, groupName: "embark-import" },
			{ source: "/existing", destination: "/pages/other", type: 301, groupName: "embark-import" },
			// Intra-batch duplicate of /new-1
			{ source: "/new-1", destination: "/pages/dup", type: 301, groupName: "embark-import" },
			// Self-loop
			{ source: "/self", destination: "/self", type: 301, groupName: "embark-import" },
			// Invalid source (no leading slash)
			{ source: "no-slash", destination: "/pages/ok", type: 301, groupName: "embark-import" },
			// Missing destination for 301
			{ source: "/missing-dest", type: 301, groupName: "embark-import" },
			// Loop against pre-existing /chain-b -> /chain-a
			{ source: "/chain-a", destination: "/chain-b", type: 301, groupName: "embark-import" },
			// Intra-batch 2-hop loop: /hop-a -> /hop-b accepted, /hop-b -> /hop-a refused
			{ source: "/hop-a", destination: "/hop-b", type: 301, groupName: "embark-import" },
			{ source: "/hop-b", destination: "/hop-a", type: 301, groupName: "embark-import" },
			// Disabled rule that would otherwise loop -> accepted
			{
				source: "/hop-b",
				destination: "/hop-a",
				type: 301,
				enabled: false,
				groupName: "embark-import",
			},
			// Terminal 410 without destination -> accepted
			{ source: "/gone-page", type: 410, groupName: "embark-import" },
		];

		// Run batch on dbBatch
		const batchRes = await handleRedirectCreateBatch(dbBatch, mixedRules);
		expect(batchRes.success, JSON.stringify(batchRes)).toBe(true);
		if (!batchRes.success) throw new Error("expected batch success");

		// Run sequential on dbSeq using the same schema + handler
		const { createRedirectBody } = await import("../../../src/api/schemas/redirects.js");
		const seqStatuses: Array<{ index: number; status: string; code?: string }> = [];
		for (let i = 0; i < mixedRules.length; i++) {
			const parsed = createRedirectBody.safeParse(mixedRules[i]);
			if (!parsed.success) {
				seqStatuses.push({ index: i, status: "refused", code: "VALIDATION_ERROR" });
				continue;
			}
			const r = await handleRedirectCreate(dbSeq, parsed.data);
			if (r.success) {
				seqStatuses.push({ index: i, status: "created" });
			} else if (r.error.code === "CONFLICT") {
				seqStatuses.push({ index: i, status: "already_exists", code: "CONFLICT" });
			} else {
				seqStatuses.push({ index: i, status: "refused", code: r.error.code });
			}
		}

		const batchStatuses = batchRes.data.results.map((r) => ({
			index: r.index,
			status: r.status,
			...(r.status === "created" ? {} : { code: r.code }),
		}));
		expect(batchStatuses).toEqual(seqStatuses);
		expect(batchRes.data.created).toBe(4);
		expect(batchRes.data.alreadyExists).toBe(2);
		expect(batchRes.data.refused).toBe(5);

		// Final DB state matches identically (by source -> destination/type/enabled)
		const normalize = async (db: Kysely<Database>) => {
			const rows = await new RedirectRepository(db).findMany({ limit: 100 });
			return rows.items
				.map((r) => ({
					source: r.source,
					destination: r.destination,
					type: r.type,
					enabled: r.enabled,
					groupName: r.groupName,
				}))
				.toSorted((a, b) => a.source.localeCompare(b.source));
		};
		expect(await normalize(dbBatch)).toEqual(await normalize(dbSeq));
	});

	it("inserts 25 rules in bounded chunks with one cache invalidation and low query count", async () => {
		const invSpy = vi.spyOn(redirectCache, "invalidateRedirectCache");
		let queryCount = 0;
		const countedDb = dbBatch.withPlugin({
			transformQuery(args) {
				queryCount++;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});

		const rules = Array.from({ length: 25 }, (_, i) => ({
			source: `/old-${i + 1}/`,
			destination: `/pages/new-${i + 1}`,
			type: 301,
			groupName: "embark-import",
		}));

		const res = await handleRedirectCreateBatch(countedDb, rules);
		expect(res.success).toBe(true);
		if (!res.success) throw new Error("expected batch success");
		expect(res.data.created).toBe(25);
		expect(res.data.alreadyExists).toBe(0);
		expect(res.data.refused).toBe(0);
		expect(invSpy).toHaveBeenCalledTimes(1);
		// 1 lock acquire + 1 findAllSources + 1 findAllEnabled + 5 multi-row INSERTs (6+6+6+6+1) + 1 lock release = 9 queries (plus optional BEGIN/COMMIT = 11)
		expect(queryCount).toBeLessThanOrEqual(15);
	});

	it("serves POST /_emdash/api/redirects/batch, enforces batch size bound, and advertises capability on analyze", async () => {
		const locals = {
			emdash: { db: dbBatch },
			user: { id: "admin", role: 100, scopes: ["admin"] },
		};

		const okRes = await batchPost({
			request: new Request("https://example.org/_emdash/api/redirects/batch", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					rules: [{ source: "/a", destination: "/b", type: 301, groupName: "embark-import" }],
				}),
			}),
			locals,
		} as never);
		expect(okRes.status).toBe(200);
		const okBody = (await okRes.json()) as { success: boolean; data: { created: number } };
		expect(okBody.success).toBe(true);
		expect(okBody.data.created).toBe(1);

		const tooBig = await batchPost({
			request: new Request("https://example.org/_emdash/api/redirects/batch", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					rules: Array.from({ length: MAX_REDIRECT_BATCH_SIZE + 1 }, (_, i) => ({
						source: `/s-${i}`,
						destination: `/d-${i}`,
					})),
				}),
			}),
			locals,
		} as never);
		expect(tooBig.status).toBe(400);
		expect(IMPORT_CAPABILITIES).toContain(BATCH_REDIRECTS_CAPABILITY);
	});
});
