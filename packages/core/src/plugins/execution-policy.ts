/**
 * What a build lets run, and where.
 *
 * The integration writes this into the config the build embeds
 * (`virtual:emdash/config`, as `execution`), from the same resolved config it
 * generates the plugin and sandbox-runner modules from. A host that deploys
 * the build can read it there as data without running anything. The runtime
 * refuses to start when it is malformed, or when it disagrees with the
 * sandbox mode the runtime was given (see EmDashRuntime.create).
 *
 * Code in `trusted` is part of the build: it runs in-process, with the
 * Worker's bindings. Everything else a site runs as a plugin is either a
 * build-time `sandboxed` entry or installed at runtime from the marketplace
 * or the registry, and runs only through the sandbox runner, unless
 * `sandboxBypassed` is true (`sandbox: false`, a debugging escape hatch that
 * Cloudflare Workers never honour; see plugins/sandbox-bypass.ts).
 */

export const EXECUTION_POLICY_VERSION = 1;

export interface ExecutionPolicy {
	v: typeof EXECUTION_POLICY_VERSION;
	/** Build-time plugins (`plugins: []`): bundled into the Worker and run in-process. */
	trusted: Array<{ id: string; entrypoint: string; format: "native" | "standard" }>;
	/** Build-time sandboxed plugins (`sandboxed: []`): bundled, and run only through the sandbox runner. */
	sandboxed: Array<{ id: string; entrypoint: string }>;
	/** The sandbox runner's module, or null: without one no sandboxed, marketplace or registry plugin runs. */
	sandboxRunner: string | null;
	/** Whether sandboxed and marketplace code would run in-process (`sandbox: false` with a runner). */
	sandboxBypassed: boolean;
	/** The marketplace plugins can be installed from at runtime, or null. */
	marketplace: string | null;
	/** Whether plugins can be installed from the registry at runtime. */
	registry: boolean;
}

/**
 * Whether a build runs sandboxed and marketplace code in-process: `sandbox:
 * false` with a runner configured, exactly as generateSandboxRunnerModule
 * decides it. Without a runner, `sandbox: false` changes nothing.
 */
export function sandboxBypassedBy(
	sandboxRunner: string | undefined,
	sandbox: boolean | undefined,
): boolean {
	return Boolean(sandboxRunner) && sandbox === false;
}

/** The execution policy of a resolved integration config. Pure. */
export function executionPolicyOf(config: {
	plugins?: ReadonlyArray<{ id: string; entrypoint: string; format?: "native" | "standard" }>;
	sandboxed?: ReadonlyArray<{ id: string; entrypoint: string }>;
	sandboxRunner?: string;
	sandbox?: boolean;
	marketplace?: string;
	/** Whether the registry tier is on (getRegistryConfigInput answers an input). */
	registry: boolean;
}): ExecutionPolicy {
	return {
		v: EXECUTION_POLICY_VERSION,
		trusted: (config.plugins ?? []).map((p) => ({
			id: p.id,
			entrypoint: p.entrypoint,
			format: p.format ?? "native",
		})),
		sandboxed: (config.sandboxed ?? []).map((p) => ({ id: p.id, entrypoint: p.entrypoint })),
		sandboxRunner: config.sandboxRunner ?? null,
		sandboxBypassed: sandboxBypassedBy(config.sandboxRunner, config.sandbox),
		marketplace: config.marketplace ?? null,
		registry: config.registry,
	};
}

const POLICY_KEYS = [
	"v",
	"trusted",
	"sandboxed",
	"sandboxRunner",
	"sandboxBypassed",
	"marketplace",
	"registry",
].toSorted();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
	JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(keys.toSorted());

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Why `value` is not an ExecutionPolicy, or null when it is one exactly: no
 * field missing, none extra, each of its type. Pure.
 */
export function executionPolicyProblem(value: unknown): string | null {
	if (!isRecord(value)) return "it is not an object";
	if (!sameKeys(value, POLICY_KEYS))
		return `its fields are ${Object.keys(value).toSorted().join(", ")}, not ${POLICY_KEYS.join(", ")}`;
	if (value.v !== EXECUTION_POLICY_VERSION)
		return `its version is ${JSON.stringify(value.v)}, not ${EXECUTION_POLICY_VERSION}`;
	if (!Array.isArray(value.trusted)) return "trusted is not a list";
	for (const p of value.trusted) {
		if (
			!isRecord(p) ||
			!sameKeys(p, ["id", "entrypoint", "format"]) ||
			!nonEmpty(p.id) ||
			!nonEmpty(p.entrypoint) ||
			(p.format !== "native" && p.format !== "standard")
		) {
			return `trusted holds ${JSON.stringify(p)}, not { id, entrypoint, format: "native" | "standard" }`;
		}
	}
	if (!Array.isArray(value.sandboxed)) return "sandboxed is not a list";
	for (const p of value.sandboxed) {
		if (
			!isRecord(p) ||
			!sameKeys(p, ["id", "entrypoint"]) ||
			!nonEmpty(p.id) ||
			!nonEmpty(p.entrypoint)
		) {
			return `sandboxed holds ${JSON.stringify(p)}, not { id, entrypoint }`;
		}
	}
	if (value.sandboxRunner !== null && !nonEmpty(value.sandboxRunner))
		return "sandboxRunner is neither a module name nor null";
	if (typeof value.sandboxBypassed !== "boolean") return "sandboxBypassed is not a boolean";
	if (value.sandboxBypassed && value.sandboxRunner === null)
		return "sandboxBypassed is true with no sandbox runner, which never bypasses anything";
	if (value.marketplace !== null && !nonEmpty(value.marketplace))
		return "marketplace is neither a URL nor null";
	if (typeof value.registry !== "boolean") return "registry is not a boolean";
	return null;
}

/**
 * Why a runtime given `sandboxBypassed` may not start on a build whose config
 * records `recorded` as its execution policy, or null. A config that records
 * none (a host that does not build through the integration) is not refused
 * here. Pure.
 */
export function executionPolicyRefusal(recorded: unknown, sandboxBypassed: unknown): string | null {
	if (recorded === undefined) return null;
	const problem = executionPolicyProblem(recorded);
	if (problem) return `the build's execution policy is malformed (${problem})`;
	const given = sandboxBypassed === true;
	if (isRecord(recorded) && recorded.sandboxBypassed !== given) {
		return `the build's execution policy says sandbox bypass is ${given ? "off" : "on"}, and this runtime was given it ${given ? "on" : "off"}`;
	}
	return null;
}
