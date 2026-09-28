/**
 * The execution policy a build embeds is the one its sandbox-runner module
 * enacts: read from the modules the integration generates, for each way a
 * config can set the sandbox. A `sandbox` or `sandboxRunner` of another type
 * is refused when the integration is created.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";
import type { EmDashConfig } from "../../../../src/astro/integration/runtime.js";
import {
	RESOLVED_VIRTUAL_CONFIG_ID,
	RESOLVED_VIRTUAL_SANDBOX_RUNNER_ID,
} from "../../../../src/astro/integration/virtual-modules.js";
import { executionPolicyProblem } from "../../../../src/plugins/execution-policy.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** The integration's generated config and sandbox-runner modules for `config`, as a build loads them. */
async function generated(
	config: EmDashConfig,
): Promise<{ config: Record<string, unknown>; runner: string }> {
	const projectRoot = await mkdtemp(join(tmpdir(), "emdash-execution-policy-"));
	roots.push(projectRoot);
	const root = pathToFileURL(`${projectRoot}/`);
	const astroConfig = {
		root,
		srcDir: new URL("src/", root),
		security: {},
		trailingSlash: "ignore",
		integrations: [{ name: "@astrojs/react", hooks: {} }],
	};
	const updateConfig = vi.fn();
	const integration: AstroIntegration = emdash(config);
	const setup = integration.hooks["astro:config:setup"];
	if (typeof setup !== "function") throw new Error("no astro:config:setup hook");
	await setup({
		command: "build",
		config: astroConfig,
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);
	const vite = updateConfig.mock.calls
		.map(([c]) => (c as { vite?: { plugins?: unknown[] } }).vite)
		.find(Boolean);
	const plugin = (vite?.plugins ?? [])
		.flat()
		.find(
			(p): p is { name: string; load: (id: string) => string } =>
				typeof p === "object" &&
				p !== null &&
				(p as { name?: string }).name === "emdash-virtual-modules",
		);
	if (!plugin) throw new Error("no emdash-virtual-modules plugin in the vite config");
	const configModule = plugin.load.call({}, RESOLVED_VIRTUAL_CONFIG_ID);
	const runner = plugin.load.call({}, RESOLVED_VIRTUAL_SANDBOX_RUNNER_ID);
	return {
		config: JSON.parse(configModule.replace(/^export default /, "").replace(/;\s*$/, "")) as Record<
			string,
			unknown
		>,
		runner,
	};
}

describe("the execution policy a build embeds", () => {
	const cases: Array<[string, EmDashConfig, boolean]> = [
		["sandbox omitted, no runner", {}, false],
		["sandbox: false, no runner", { sandbox: false }, false],
		["a runner", { sandboxRunner: "@example/runner" }, false],
		["a runner and sandbox: true", { sandboxRunner: "@example/runner", sandbox: true }, false],
		["a runner and sandbox: false", { sandboxRunner: "@example/runner", sandbox: false }, true],
	];

	it.each(cases)(
		"with %s says what its sandbox-runner module does",
		async (_what, config, bypassed) => {
			const built = await generated(config);
			const policy = built.config.execution as Record<string, unknown>;

			expect(executionPolicyProblem(policy)).toBeNull();
			expect(policy.sandboxBypassed).toBe(bypassed);
			expect(built.runner.includes("export const sandboxBypassed = true;")).toBe(bypassed);
			expect(policy.sandboxRunner).toBe(config.sandboxRunner ?? null);
		},
	);

	it("names the build-time plugins, the marketplace and the registry the build turns on", async () => {
		const built = await generated({
			plugins: [{ id: "probe", version: "1.0.0", entrypoint: "@example/probe" }],
			marketplace: "https://marketplace.example.com",
			sandboxRunner: "@example/runner",
		});
		expect(built.config.execution).toEqual({
			v: 1,
			trusted: [{ id: "probe", entrypoint: "@example/probe", format: "native" }],
			sandboxed: [],
			sandboxRunner: "@example/runner",
			sandboxBypassed: false,
			marketplace: "https://marketplace.example.com",
			// A runner with the sandbox on turns the default registry on (registry/config.ts).
			registry: true,
		});
		expect(
			(await generated({ registry: false, sandboxRunner: "@example/runner" })).config.execution,
		).toMatchObject({ registry: false });
	});

	it("replaces an execution field the site's config sets", async () => {
		const built = await generated({
			execution: { v: 1, sandboxBypassed: false, forged: true },
		} as EmDashConfig);
		expect(executionPolicyProblem(built.config.execution)).toBeNull();
		expect(built.config.execution).not.toHaveProperty("forged");
	});
});

describe("a sandbox config of another type", () => {
	it.each([
		["sandbox as a string", { sandbox: "false" }, /sandbox must be true or false, got "false"/],
		["sandbox as a number", { sandbox: 0 }, /sandbox must be true or false, got 0/],
		["sandboxRunner as a number", { sandboxRunner: 5 }, /sandboxRunner must name a module, got 5/],
		["an empty sandboxRunner", { sandboxRunner: "" }, /sandboxRunner must name a module, got ""/],
	])("is refused: %s", (_what, config, message) => {
		expect(() => emdash(config as never)).toThrow(message);
	});
});
