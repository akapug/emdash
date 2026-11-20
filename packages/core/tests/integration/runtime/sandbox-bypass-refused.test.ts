/**
 * `sandbox: false` is refused on Cloudflare Workers before any plugin code is
 * loaded, however many sandboxed entries the build has. The case that the
 * entry count used to decide: no build-time sandboxed plugin, a marketplace
 * and site storage, and a marketplace plugin installed and active. Loaded in
 * bypass mode, its code would run in-process with the Worker's whole
 * environment.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { SANDBOX_BYPASS_REFUSED_ON_WORKERS } from "../../../src/plugins/sandbox-bypass.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import type { DownloadResult, Storage } from "../../../src/storage/types.js";

const MARKETPLACE_URL = "https://marketplace.example.com";
const PLUGIN = "bypass-probe";

/** Site storage holding one marketplace bundle; every read is recorded. */
function siteStorage(): { storage: Storage; reads: string[] } {
	const reads: string[] = [];
	const files = new Map<string, string>([
		[
			`marketplace/${PLUGIN}/1.0.0/manifest.json`,
			JSON.stringify({
				id: PLUGIN,
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			}),
		],
		[`marketplace/${PLUGIN}/1.0.0/backend.js`, "export default { hooks: {} };"],
	]);
	const refuse = async (): Promise<never> => {
		throw new Error("not used by this test");
	};
	const storage: Storage = {
		upload: refuse,
		async download(key: string): Promise<DownloadResult> {
			reads.push(key);
			const text = files.get(key);
			if (text === undefined) throw new Error(`Not found: ${key}`);
			const bytes = new TextEncoder().encode(text);
			return {
				body: new Response(bytes).body!,
				contentType: "application/octet-stream",
				size: bytes.length,
			};
		},
		delete: refuse,
		exists: async (key: string) => files.has(key),
		list: async () => ({ files: [] }),
		getSignedUploadUrl: refuse,
		getPublicUrl: (key: string) => `https://storage.example.com/${key}`,
	};
	return { storage, reads };
}

/** A migrated database whose one marketplace plugin is installed and active. */
async function siteDatabase(): Promise<Database.Database> {
	const sqlite = new Database(":memory:");
	const db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
	await runMigrations(db);
	await new PluginStateRepository(db).upsert(PLUGIN, "1.0.0", "active", {
		source: "marketplace",
		marketplaceVersion: "1.0.0",
	});
	return sqlite;
}

/** `flag` is the runtime's `sandboxBypassed`, or `{ omitted: true }` for a dependency set without one. */
async function bypassSite(
	flag: { sandboxBypassed: unknown } | { omitted: true } = { sandboxBypassed: true },
) {
	const sqlite = await siteDatabase();
	const { storage, reads } = siteStorage();
	const dialects: string[] = [];
	const deps: RuntimeDependencies = {
		config: {
			database: { entrypoint: `test-bypass-db-${randomUUID()}`, config: {}, type: "sqlite" },
			storage: { entrypoint: `test-bypass-storage-${randomUUID()}`, config: {} },
			marketplace: MARKETPLACE_URL,
		},
		plugins: [],
		createDialect: () => {
			dialects.push("made");
			return new SqliteDialect({ database: sqlite });
		},
		createStorage: () => storage,
		sandboxEnabled: true,
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a malformed flag is a case under test
		...("sandboxBypassed" in flag ? { sandboxBypassed: flag.sandboxBypassed as boolean } : {}),
		// No build-time sandboxed plugin: the count that used to decide the refusal.
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
	return { deps, reads, dialects };
}

const onWorkers = () => vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

describe("sandbox: false on Cloudflare Workers", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("refuses to start before the database or any plugin bundle is touched, with no sandboxed entry in the build", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		onWorkers();
		const { deps, reads, dialects } = await bypassSite();

		await expect(EmDashRuntime.create(deps)).rejects.toThrow(SANDBOX_BYPASS_REFUSED_ON_WORKERS);
		expect(reads).toEqual([]);
		expect(dialects).toEqual([]);
	});

	it("CONTROL: off Workers the same site starts and reads the marketplace plugin's bundle in-process", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { deps, reads } = await bypassSite();

		const runtime = await EmDashRuntime.create(deps);
		try {
			expect(reads).toContain(`marketplace/${PLUGIN}/1.0.0/manifest.json`);
			expect(runtime.isSandboxBypassed()).toBe(true);
		} finally {
			await runtime.stopCron();
		}
	});

	it("a sync after install or update refuses on Workers, and isSandboxBypassed() reads false there", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { deps, reads } = await bypassSite();
		// Started off Workers (the control above), then asked on Workers: the
		// sync refuses by itself, not because the start did.
		const runtime = await EmDashRuntime.create(deps);
		try {
			const before = reads.length;
			onWorkers();
			expect(runtime.isSandboxBypassed()).toBe(false);
			await expect(runtime.syncMarketplacePlugins()).rejects.toThrow(
				SANDBOX_BYPASS_REFUSED_ON_WORKERS,
			);
			expect(reads.length).toBe(before);
		} finally {
			vi.unstubAllGlobals();
			await runtime.stopCron();
		}
	});

	it("a sandboxBypassed that is not a boolean is refused everywhere, rather than read as either answer", async () => {
		const { deps, reads, dialects } = await bypassSite({ sandboxBypassed: "true" });

		await expect(EmDashRuntime.create(deps)).rejects.toThrow(
			/sandboxBypassed must be true or false, not string/,
		);
		expect(reads).toEqual([]);
		expect(dialects).toEqual([]);
	});

	it("an omitted sandboxBypassed starts the site with nothing loaded in-process", async () => {
		onWorkers();
		const { deps, reads } = await bypassSite({ omitted: true });

		const runtime = await EmDashRuntime.create(deps);
		try {
			expect(reads).toEqual([]);
			expect(runtime.isSandboxBypassed()).toBe(false);
		} finally {
			await runtime.stopCron();
		}
	});
});
