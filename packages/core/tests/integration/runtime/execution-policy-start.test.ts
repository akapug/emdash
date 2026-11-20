/**
 * The runtime holds the execution policy its build records (config.execution)
 * to the sandbox mode it is given, before it opens the database: a policy that
 * is malformed, or that names the other mode, and nothing starts.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import type { ExecutionPolicy } from "../../../src/plugins/execution-policy.js";

const POLICY: ExecutionPolicy = {
	v: 1,
	trusted: [],
	sandboxed: [],
	sandboxRunner: null,
	sandboxBypassed: false,
	marketplace: null,
	registry: false,
};

function site(execution: unknown, sandboxBypassed: boolean) {
	const dialects: string[] = [];
	const deps: RuntimeDependencies = {
		config: {
			database: { entrypoint: `test-policy-db-${randomUUID()}`, config: {}, type: "sqlite" },
			// The integration writes it beside the rest of the config (virtual:emdash/config).
			...({ execution } as object),
		},
		plugins: [],
		createDialect: () => {
			dialects.push("made");
			return new SqliteDialect({ database: new Database(":memory:") });
		},
		createStorage: null,
		sandboxEnabled: false,
		sandboxBypassed,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
	return { deps, dialects };
}

describe("the runtime and its build's execution policy", () => {
	it("starts when the policy records the sandbox mode it is given", async () => {
		const { deps } = site(POLICY, false);
		const runtime = await EmDashRuntime.create(deps);
		await runtime.stopCron();
	});

	it("refuses, before the database, a runtime given bypass on a build whose policy has it off", async () => {
		const { deps, dialects } = site(POLICY, true);
		await expect(EmDashRuntime.create(deps)).rejects.toThrow(
			/the build's execution policy says sandbox bypass is off, and this runtime was given it on: refusing to start/,
		);
		expect(dialects).toEqual([]);
	});

	it("refuses a malformed policy before the database", async () => {
		const { deps, dialects } = site({ ...POLICY, sandboxBypassed: "false" }, false);
		await expect(EmDashRuntime.create(deps)).rejects.toThrow(
			/execution policy is malformed \(sandboxBypassed is not a boolean\)/,
		);
		expect(dialects).toEqual([]);
	});

	it("CONTROL: a config that records no policy starts as before", async () => {
		const { deps } = site(undefined, false);
		const runtime = await EmDashRuntime.create(deps);
		await runtime.stopCron();
	});
});
