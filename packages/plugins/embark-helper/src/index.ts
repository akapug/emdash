/**
 * The AI Helper for EmDash sites that Embark hosts.
 *
 * An "AI Helper" admin page and a dashboard widget. Each one talks only to
 * Embark's control plane, `POST https://embarkeasy.com/api/tenant-helper/<op>`
 * (`overview`, `turn`, `approve`, `reject`, `toggle`), with the site's link
 * key as a bearer token and the signed-in user as `X-Embark-User`, the JSON
 * `{ id, email, role }` where `role` is the EmDash role's name ("editor",
 * "admin"). Editors and administrators use it; only an administrator turns
 * it on or off.
 *
 * An Embark operator writes the link key into this plugin's KV row `linkKey`:
 * the options row `plugin:embark-helper:linkKey`, whose value is the key as a
 * JSON string. Until that row exists the plugin sends no request and says
 * that the Helper comes with Embark hosting.
 *
 * @example
 * ```typescript
 * import { embarkHelperPlugin } from "@emdash-cms/plugin-embark-helper";
 *
 * emdash({ plugins: [embarkHelperPlugin()] });
 * ```
 */

import type { PluginDescriptor, ResolvedPlugin, RouteContext } from "emdash";
import { definePlugin } from "emdash";

import { helperAdmin } from "./helper.js";

const PLUGIN_ID = "embark-helper";
const VERSION = "0.1.0";
const CAPABILITIES = ["network:request"] as const;
const ALLOWED_HOSTS = ["embarkeasy.com"];
const PAGES = [{ path: "/", label: "AI Helper", icon: "sparkle" }];
const WIDGETS = [{ id: "allowance", title: "AI Helper", size: "third" as const }];

export function embarkHelperPlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: VERSION,
		entrypoint: "@emdash-cms/plugin-embark-helper",
		options: {},
		capabilities: [...CAPABILITIES],
		allowedHosts: [...ALLOWED_HOSTS],
		adminPages: PAGES,
		adminWidgets: WIDGETS,
	};
}

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: [...CAPABILITIES],
		allowedHosts: [...ALLOWED_HOSTS],
		routes: {
			admin: {
				// The editor role's permission, since approving a proposal publishes it.
				permission: "content:publish_any",
				handler: async (ctx: RouteContext) => helperAdmin(ctx),
			},
		},
		admin: { pages: PAGES, widgets: WIDGETS },
	});
}

export default createPlugin;
