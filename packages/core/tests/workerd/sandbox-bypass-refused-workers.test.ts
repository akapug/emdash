/**
 * In workerd itself, with `navigator` as workerd sets it (no stub):
 * `sandbox: false` is refused when the runtime starts, before its dialect or
 * storage is made, with no build-time sandboxed entry and a marketplace
 * configured; and a marketplace install or update asked in bypass mode is
 * refused before it touches its database, storage or the marketplace.
 */

import { expect, it } from "vitest";

import {
	handleMarketplaceInstall,
	handleMarketplaceUpdate,
} from "../../src/api/handlers/marketplace.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../src/emdash-runtime.js";
import {
	SANDBOX_BYPASS_REFUSED_ON_WORKERS,
	isCloudflareWorkersRuntime,
} from "../../src/plugins/sandbox-bypass.js";

const MARKETPLACE_URL = "https://marketplace.example.com";

/** A stand-in every use of which is recorded, and fails. */
function untouchable<T>(name: string, used: string[]): T {
	// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a stand-in the code under test must never use
	return new Proxy(
		{},
		{
			get(_target, property) {
				used.push(`${name}.${String(property)}`);
				throw new Error(`${name} is not reached`);
			},
		},
	) as T;
}

it("workerd names itself Cloudflare-Workers, and the refusal reads that", () => {
	expect(navigator.userAgent).toContain("Cloudflare-Workers");
	expect(isCloudflareWorkersRuntime()).toBe(true);
});

it("the runtime refuses sandbox: false before its dialect or storage is made, with no sandboxed entry and a marketplace", async () => {
	const made: string[] = [];
	const deps: RuntimeDependencies = {
		config: {
			database: { entrypoint: "test-workerd-bypass-db", config: {}, type: "sqlite" },
			storage: { entrypoint: "test-workerd-bypass-storage", config: {} },
			marketplace: MARKETPLACE_URL,
		},
		plugins: [],
		createDialect: () => {
			made.push("dialect");
			throw new Error("the dialect is not reached");
		},
		createStorage: () => {
			made.push("storage");
			throw new Error("storage is not reached");
		},
		sandboxEnabled: true,
		sandboxBypassed: true,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	await expect(EmDashRuntime.create(deps)).rejects.toThrow(SANDBOX_BYPASS_REFUSED_ON_WORKERS);
	expect(made).toEqual([]);
});

it.each([
	["install", handleMarketplaceInstall],
	["update", handleMarketplaceUpdate],
] as const)(
	"marketplace %s in bypass mode is refused before its database, storage or the marketplace",
	async (_name, handle) => {
		const used: string[] = [];
		const result = await handle(
			untouchable("db", used),
			untouchable("storage", used),
			null,
			MARKETPLACE_URL,
			"test-seo",
			{ sandboxBypassed: true },
		);

		expect(result).toEqual({
			success: false,
			error: { code: "SANDBOX_BYPASS_REFUSED", message: SANDBOX_BYPASS_REFUSED_ON_WORKERS },
		});
		expect(used).toEqual([]);
	},
);
