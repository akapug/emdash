import { getSiteSettingsWithCacheHint } from "emdash";

import { WP_SHELL_SETTING, parseWpShellCached, type WpShell } from "./wp-shell";

/**
 * The site's WordPress shell record, or null.
 *
 * WHY A SITE SETTING. The record is the options row `site:wpShell`. Every
 * public page already reads the `site:*` rows (the layout needs the title and
 * logo), once per isolate per 30 s through EmDash's settings cache, and a
 * write through the settings path invalidates that cache and the settings
 * cache tag. So the record costs no query of its own, comes with a cache hint,
 * and is part of the site's database: its backups and exports carry it. A KV
 * key would be a second store with its own staleness and no backup, and plugin
 * storage is not reachable from a layout without a plugin in the way.
 *
 * The settings API does not accept this key (its schema strips unknown
 * fields), so the admin cannot overwrite it; Embark writes the row directly.
 * A direct write reaches every isolate within the settings TTL (30 s).
 */
export async function loadWpShell(): Promise<{
	shell: WpShell | null;
	cacheHint: Awaited<ReturnType<typeof getSiteSettingsWithCacheHint>>["cacheHint"];
}> {
	const { data, cacheHint } = await getSiteSettingsWithCacheHint();
	// The settings object carries every `site:*` row, typed or not.
	const value: unknown = (data as Record<string, unknown>)[WP_SHELL_SETTING];
	const shell = parseWpShellCached(value, (why) =>
		console.warn(JSON.stringify({ event: "wp_shell_refused", why })),
	);
	return { shell, cacheHint };
}
