/**
 * Regression for #3432: SeedField must carry `translatable` through apply and
 * export round-trips. Without it, non-translatable fields are silently stored
 * as translatable, and `emdash export-seed` loses the flag again.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportSeed } from "../../src/cli/commands/export-seed.js";
import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

describe("seed translatable round-trip (#3432)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function seed(): SeedFile {
		return {
			version: "1",
			collections: [
				{
					slug: "projects",
					label: "Projects",
					fields: [
						{ slug: "title", label: "Title", type: "string" },
						{
							slug: "featured_image",
							label: "Featured Image",
							type: "image",
							translatable: false,
						},
						{
							slug: "homepage",
							label: "Homepage",
							type: "url",
							translatable: false,
						},
						{ slug: "description", label: "Description", type: "text", translatable: true },
					],
				},
			],
		};
	}

	it("stores translatable=false from a fresh seed", async () => {
		await applySeed(db, seed());

		const rows = await db
			.selectFrom("_emdash_fields")
			.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
			.select(["_emdash_fields.slug", "_emdash_fields.translatable"])
			.where("_emdash_collections.slug", "=", "projects")
			.orderBy("_emdash_fields.slug")
			.execute();

		expect(rows).toEqual([
			{ slug: "description", translatable: 1 },
			{ slug: "featured_image", translatable: 0 },
			{ slug: "homepage", translatable: 0 },
			{ slug: "title", translatable: 1 },
		]);
	});

	it("preserves translatable=false when re-applying in update mode", async () => {
		await applySeed(db, seed());
		const updated = seed();
		updated.collections![0]!.label = "Updated Projects";
		await applySeed(db, updated, { onConflict: "update" });

		const rows = await db
			.selectFrom("_emdash_fields")
			.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
			.select(["_emdash_fields.slug", "_emdash_fields.translatable"])
			.where("_emdash_collections.slug", "=", "projects")
			.execute();

		for (const row of rows) {
			if (row.slug === "featured_image" || row.slug === "homepage") {
				expect(row.translatable).toBe(0);
			} else {
				expect(row.translatable).toBe(1);
			}
		}
	});

	it("exports translatable=false and omits it for default-true fields", async () => {
		await applySeed(db, seed());

		const exported = await exportSeed(db);
		const projects = exported.collections?.find((collection) => collection.slug === "projects");
		expect(projects).toBeDefined();

		const fields = new Map(projects!.fields.map((field) => [field.slug, field]));
		expect(fields.get("featured_image")?.translatable).toBe(false);
		expect(fields.get("homepage")?.translatable).toBe(false);
		expect(fields.get("description")?.translatable).toBeUndefined();
		expect(fields.get("title")?.translatable).toBeUndefined();
	});
});
