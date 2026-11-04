/**
 * A marketplace install or update asked in `sandbox: false` bypass mode is
 * refused on Cloudflare Workers before anything else happens: no marketplace
 * request, no storage read, no state change. Off Workers the same call passes
 * that gate (the control). The registry takes no bypass at all.
 */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	handleMarketplaceInstall,
	handleMarketplaceUpdate,
} from "../../../src/api/handlers/marketplace.js";
import { handleRegistryInstall, handleRegistryUpdate } from "../../../src/api/handlers/registry.js";
import type { ApiResult } from "../../../src/api/types.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import {
	SANDBOX_BYPASS_REFUSED_ON_WORKERS,
	sandboxBypassRefusal,
} from "../../../src/plugins/sandbox-bypass.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import type { Storage } from "../../../src/storage/types.js";

const MARKETPLACE_URL = "https://marketplace.example.com";
const REGISTRY = { aggregatorUrl: "https://aggregator.example.com" };

/** The runner bypass mode runs with: the noop runner, never available. */
const noopRunner: SandboxRunner = {
	isAvailable: () => false,
	isHealthy: () => false,
	load: () => Promise.reject(new Error("load is not reached")),
	setEmailSend: () => {},
	terminateAll: async () => {},
};

/** Storage every call on which is recorded, and refused. */
function watchedStorage(): { storage: Storage; calls: string[] } {
	const calls: string[] = [];
	const refuse = (name: string) => async (): Promise<never> => {
		calls.push(name);
		throw new Error(`storage.${name} was called`);
	};
	return {
		calls,
		storage: {
			upload: refuse("upload"),
			download: refuse("download"),
			delete: refuse("delete"),
			exists: refuse("exists"),
			list: refuse("list"),
			getSignedUploadUrl: refuse("getSignedUploadUrl"),
			getPublicUrl: (key: string) => `https://storage.example.com/${key}`,
		},
	};
}

describe("marketplace install and update in sandbox bypass mode", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: BetterSqlite3.Database;
	let requests: string[];

	beforeEach(async () => {
		sqliteDb = new BetterSqlite3(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqliteDb }) });
		await runMigrations(db);
		// The update needs an installed marketplace plugin to get past its own checks.
		await new PluginStateRepository(db).upsert("test-seo", "1.0.0", "active", {
			source: "marketplace",
			marketplaceVersion: "1.0.0",
		});
		requests = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			requests.push(String(input instanceof Request ? input.url : input));
			return new Response("not found", { status: 404 });
		});
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await db.destroy();
		sqliteDb.close();
	});

	const calls: Array<
		[string, (storage: Storage, sandboxBypassed: unknown) => Promise<ApiResult<unknown>>]
	> = [
		[
			"install",
			(storage, sandboxBypassed) =>
				// Not installed yet, so a call past the gates asks the marketplace for it.
				handleMarketplaceInstall(db, storage, noopRunner, MARKETPLACE_URL, "fresh-seo", {
					// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- malformed flags are cases under test
					sandboxBypassed: sandboxBypassed as boolean,
				}),
		],
		[
			"update",
			(storage, sandboxBypassed) =>
				handleMarketplaceUpdate(db, storage, noopRunner, MARKETPLACE_URL, "test-seo", {
					// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- malformed flags are cases under test
					sandboxBypassed: sandboxBypassed as boolean,
				}),
		],
	];

	it.each(calls)(
		"%s is refused on Workers before any marketplace request or storage call",
		async (_name, call) => {
			vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
			const { storage, calls: used } = watchedStorage();
			const state = new PluginStateRepository(db);
			const before = [await state.get("test-seo"), await state.get("fresh-seo")];

			const result = await call(storage, true);

			expect(result).toEqual({
				success: false,
				error: { code: "SANDBOX_BYPASS_REFUSED", message: SANDBOX_BYPASS_REFUSED_ON_WORKERS },
			});
			expect(requests).toEqual([]);
			expect(used).toEqual([]);
			expect([await state.get("test-seo"), await state.get("fresh-seo")]).toEqual(before);
		},
	);

	it.each(calls)(
		"CONTROL: %s off Workers passes the bypass gate and asks the marketplace",
		async (_name, call) => {
			const { storage } = watchedStorage();

			const result = await call(storage, true);

			expect(result.error?.code).not.toBe("SANDBOX_BYPASS_REFUSED");
			expect(result.error?.code).not.toBe("SANDBOX_NOT_AVAILABLE");
			expect(requests.length).toBeGreaterThan(0);
		},
	);

	it.each(calls)(
		"%s with a sandboxBypassed that is not a boolean is refused off Workers too",
		async (_name, call) => {
			const { storage, calls: used } = watchedStorage();

			const result = await call(storage, "true");

			expect(result.error?.code).toBe("SANDBOX_BYPASS_REFUSED");
			expect(result.error?.message).toMatch(/must be true or false, not string/);
			expect(requests).toEqual([]);
			expect(used).toEqual([]);
		},
	);

	it.each(calls)(
		"%s with sandboxBypassed omitted keeps the runner gate on Workers",
		async (_name, call) => {
			vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
			const { storage } = watchedStorage();

			const result = await call(storage, undefined);

			expect(result.error?.code).toBe("SANDBOX_NOT_AVAILABLE");
			expect(requests).toEqual([]);
		},
	);

	it("the registry takes no bypass: its install and update keep the runner gate in bypass mode on Workers", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
		const { storage } = watchedStorage();

		const install = await handleRegistryInstall(db, storage, noopRunner, REGISTRY, {
			did: "did:plc:abc",
			slug: "gallery",
		});
		const update = await handleRegistryUpdate(
			db,
			storage,
			noopRunner,
			REGISTRY,
			"r_dddddddddddddddd",
		);

		expect(install.error?.code).toBe("SANDBOX_NOT_AVAILABLE");
		expect(update.error?.code).toBe("SANDBOX_NOT_AVAILABLE");
		expect(requests).toEqual([]);
	});
});

describe("sandboxBypassRefusal", () => {
	it("refuses true on Workers only, never false or omitted, and anything else everywhere", () => {
		for (const onWorkers of [true, false]) {
			expect(sandboxBypassRefusal(undefined, onWorkers)).toBeNull();
			expect(sandboxBypassRefusal(false, onWorkers)).toBeNull();
			for (const malformed of ["true", 1, null, {}]) {
				expect(sandboxBypassRefusal(malformed, onWorkers)).toMatch(/must be true or false/);
			}
		}
		expect(sandboxBypassRefusal(true, true)).toBe(SANDBOX_BYPASS_REFUSED_ON_WORKERS);
		expect(sandboxBypassRefusal(true, false)).toBeNull();
	});
});
