/**
 * Whether `sandbox: false` may be honoured where this code runs.
 *
 * `sandbox: false` is a debugging escape hatch. With a sandbox runner
 * configured, it loads the build's sandboxed plugins, and every plugin
 * installed from the marketplace, as trusted in-process code: with the
 * Worker's whole environment and none of the scoped capabilities the sandbox
 * enforces. On Cloudflare Workers it is never honoured, whatever else the site
 * configures. A site with no build-time sandboxed plugin can still install
 * marketplace code, which would then run unisolated, so the refusal does not
 * depend on how many sandboxed entries the build has.
 *
 * Every path that would load such code in-process asks here first: the
 * runtime's start, marketplace install and update, and the runtime sync after
 * them. None of them relies on another having refused.
 */

export const SANDBOX_BYPASS_REFUSED_ON_WORKERS =
	"sandbox: false is not supported in Cloudflare Workers. " +
	"Remove the sandbox: false option or use the Cloudflare sandbox runner.";

/** Whether this code runs in Cloudflare Workers, whose runtime (workerd) names itself in `navigator.userAgent`. */
export function isCloudflareWorkersRuntime(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.userAgent === "string" &&
		navigator.userAgent.includes("Cloudflare-Workers")
	);
}

/**
 * Why a runtime given `sandboxBypassed` may not honour it, or null when it
 * may. Never on Cloudflare Workers. A value that is not a boolean is refused
 * everywhere, rather than read as either answer.
 */
export function sandboxBypassRefusal(
	sandboxBypassed: unknown,
	onWorkers: boolean = isCloudflareWorkersRuntime(),
): string | null {
	if (sandboxBypassed === undefined || sandboxBypassed === false) return null;
	if (sandboxBypassed !== true) {
		return `sandboxBypassed must be true or false, not ${typeof sandboxBypassed}: refusing to guess whether plugin code runs isolated`;
	}
	return onWorkers ? SANDBOX_BYPASS_REFUSED_ON_WORKERS : null;
}

/** Throws the refusal, if there is one. Called first by every in-process load of sandboxed or marketplace code. */
export function assertSandboxBypassAllowed(sandboxBypassed: unknown = true): void {
	const refused = sandboxBypassRefusal(sandboxBypassed);
	if (refused) throw new Error(refused);
}
