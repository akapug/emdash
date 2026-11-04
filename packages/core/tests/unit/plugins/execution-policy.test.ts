/**
 * A build's execution policy (plugins/execution-policy.ts): what it lets run,
 * read exactly, and held by the runtime to the sandbox mode it is given.
 */

import { describe, expect, it } from "vitest";

import {
	executionPolicyOf,
	executionPolicyProblem,
	executionPolicyRefusal,
	type ExecutionPolicy,
} from "../../../src/plugins/execution-policy.js";

const TEMPLATE: ExecutionPolicy = {
	v: 1,
	trusted: [
		{ id: "emdash-forms", entrypoint: "@emdash-cms/plugin-forms", format: "native" },
		{
			id: "cloudflare-email",
			entrypoint: "@emdash-cms/cloudflare/plugins/cloudflare-email",
			format: "native",
		},
	],
	sandboxed: [],
	sandboxRunner: null,
	sandboxBypassed: false,
	marketplace: null,
	registry: false,
};

describe("executionPolicyOf", () => {
	it("an empty config lets nothing run beyond the build, and nothing unsandboxed", () => {
		expect(executionPolicyOf({ registry: false })).toEqual({
			v: 1,
			trusted: [],
			sandboxed: [],
			sandboxRunner: null,
			sandboxBypassed: false,
			marketplace: null,
			registry: false,
		});
	});

	it("names each build-time plugin, a plugin with no format as native", () => {
		const policy = executionPolicyOf({
			plugins: [
				{ id: "a", entrypoint: "@example/a" },
				{ id: "b", entrypoint: "@example/b", format: "standard" },
			],
			sandboxed: [{ id: "c", entrypoint: "@example/c" }],
			sandboxRunner: "@example/runner",
			marketplace: "https://marketplace.example.com",
			registry: true,
		});
		expect(policy.trusted).toEqual([
			{ id: "a", entrypoint: "@example/a", format: "native" },
			{ id: "b", entrypoint: "@example/b", format: "standard" },
		]);
		expect(policy.sandboxed).toEqual([{ id: "c", entrypoint: "@example/c" }]);
		expect(policy).toMatchObject({
			sandboxRunner: "@example/runner",
			sandboxBypassed: false,
			marketplace: "https://marketplace.example.com",
			registry: true,
		});
	});

	it("sandbox: false bypasses only with a runner", () => {
		expect(executionPolicyOf({ sandbox: false, registry: false }).sandboxBypassed).toBe(false);
		expect(
			executionPolicyOf({ sandbox: false, sandboxRunner: "@example/runner", registry: false })
				.sandboxBypassed,
		).toBe(true);
		expect(
			executionPolicyOf({ sandbox: true, sandboxRunner: "@example/runner", registry: false })
				.sandboxBypassed,
		).toBe(false);
	});
});

describe("executionPolicyProblem", () => {
	it("takes the template's own policy as it is", () => {
		expect(executionPolicyProblem(TEMPLATE)).toBeNull();
	});

	const malformed: Array<[string, unknown]> = [
		["not an object", "policy"],
		["a list", [TEMPLATE]],
		["null", null],
		["a field missing", (({ registry: _r, ...rest }) => rest)(TEMPLATE)],
		["a field extra", { ...TEMPLATE, loader: true }],
		["another version", { ...TEMPLATE, v: 2 }],
		[
			"a trusted entry with no format",
			{ ...TEMPLATE, trusted: [{ id: "a", entrypoint: "@example/a" }] },
		],
		[
			"a trusted entry of another format",
			{ ...TEMPLATE, trusted: [{ id: "a", entrypoint: "@example/a", format: "trusted" }] },
		],
		[
			"a trusted entry with an empty id",
			{ ...TEMPLATE, trusted: [{ id: "", entrypoint: "@example/a", format: "native" }] },
		],
		["trusted not a list", { ...TEMPLATE, trusted: {} }],
		[
			"a sandboxed entry with a field extra",
			{ ...TEMPLATE, sandboxed: [{ id: "a", entrypoint: "@example/a", code: "x" }] },
		],
		["an empty sandbox runner", { ...TEMPLATE, sandboxRunner: "" }],
		["sandboxBypassed as a string", { ...TEMPLATE, sandboxBypassed: "false" }],
		["sandboxBypassed with no runner", { ...TEMPLATE, sandboxBypassed: true }],
		["an empty marketplace", { ...TEMPLATE, marketplace: "" }],
		["registry as a string", { ...TEMPLATE, registry: "false" }],
	];

	it.each(malformed)("refuses a policy that is %s", (_what, value) => {
		expect(executionPolicyProblem(value)).toEqual(expect.any(String));
	});
});

describe("executionPolicyRefusal", () => {
	const bypassed: ExecutionPolicy = {
		...TEMPLATE,
		sandboxRunner: "@example/runner",
		sandboxBypassed: true,
	};

	it("starts a runtime whose sandbox mode is the one its build records", () => {
		expect(executionPolicyRefusal(TEMPLATE, false)).toBeNull();
		expect(executionPolicyRefusal(TEMPLATE, undefined)).toBeNull();
		expect(executionPolicyRefusal(bypassed, true)).toBeNull();
	});

	it("does not refuse a config that records no policy", () => {
		expect(executionPolicyRefusal(undefined, true)).toBeNull();
	});

	it("refuses a runtime given another sandbox mode than its build records, either way", () => {
		expect(executionPolicyRefusal(TEMPLATE, true)).toMatch(
			/says sandbox bypass is off, and this runtime was given it on/,
		);
		expect(executionPolicyRefusal(bypassed, false)).toMatch(
			/says sandbox bypass is on, and this runtime was given it off/,
		);
	});

	it("refuses a malformed policy", () => {
		expect(executionPolicyRefusal({ ...TEMPLATE, registry: "no" }, false)).toMatch(
			/malformed \(registry is not a boolean\)/,
		);
	});
});
