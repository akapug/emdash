/**
 * The isolate's site-settings cache expires, so a write made by another
 * isolate reaches this one within the TTL. A write invalidates only the
 * isolate that made it, and a Worker isolate kept busy by traffic does not
 * recycle, so without the TTL "/" kept rendering the latest posts after the
 * homepage was set (measured on a live Worker, 2026-09-26).
 */

import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import {
	getSiteSettings,
	invalidateSiteSettingsCache,
	setSiteSettings,
} from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

class QueryCounter implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count++;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

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

	it("keeps a copy read after a local write for a full TTL from that read", async () => {
		await setSiteSettings({ title: "Before" }, db);
		await read();
		vi.setSystemTime(new Date("2026-09-26T00:00:25Z"));
		await setSiteSettings({ title: "After" }, db);
		expect((await read()).title).toBe("After");

		const counter = new QueryCounter();
		vi.setSystemTime(new Date("2026-09-26T00:00:31Z"));
		const settings = await runWithContext({ editMode: false, db: db.withPlugin(counter) }, () =>
			getSiteSettings(),
		);

		expect(settings.title).toBe("After");
		expect(counter.count).toBe(0);
	});

	it("reads the settings once for a burst of requests at expiry", async () => {
		await new OptionsRepository(db).set("site:title", "Before");
		await read();
		await new OptionsRepository(db).set("site:title", "After");
		vi.setSystemTime(new Date("2026-09-26T00:00:31Z"));

		const counter = new QueryCounter();
		const counted = db.withPlugin(counter);
		const burst = await Promise.all(
			Array.from({ length: 5 }, () =>
				runWithContext({ editMode: false, db: counted }, () => getSiteSettings()),
			),
		);

		expect(burst.map((settings) => settings.title)).toEqual(Array(5).fill("After"));
		expect(counter.count).toBe(1);
	});
});
