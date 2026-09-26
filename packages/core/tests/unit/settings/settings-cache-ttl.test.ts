/**
 * The isolate's site-settings cache expires, so a write made by another
 * isolate reaches this one within the TTL. A write invalidates only the
 * isolate that made it, and a Worker isolate kept busy by traffic does not
 * recycle, so without the TTL "/" kept rendering the latest posts after the
 * homepage was set (measured on a live Worker, 2026-09-26).
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { getSiteSettings, invalidateSiteSettingsCache } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("the isolate's site-settings cache", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		invalidateSiteSettingsCache();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		invalidateSiteSettingsCache();
		await teardownTestDatabase(db);
	});

	const read = () => runWithContext({ editMode: false, db }, () => getSiteSettings());

	it("serves another isolate's write once its TTL has passed, and not before", async () => {
		const options = new OptionsRepository(db);
		await options.set("site:title", "Before");
		expect((await read()).title).toBe("Before");

		// Another isolate's write: the database changes and this isolate is not told.
		await options.set("site:title", "After");
		vi.setSystemTime(new Date("2026-09-26T00:00:20Z"));
		expect((await read()).title).toBe("Before");

		vi.setSystemTime(new Date("2026-09-26T00:00:31Z"));
		expect((await read()).title).toBe("After");
	});
});
