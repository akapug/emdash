/**
 * Subscriptions Plugin for EmDash CMS
 *
 * Visitors subscribe to a site's new posts by email, with a double opt-in:
 * a form posts an address, a confirmation email's link confirms it, each new
 * post goes to the confirmed addresses, and every email carries a link that
 * unsubscribes. Works with no script: the form is a plain HTML form, and each
 * route answers by sending the visitor back to the page with `?subscribe=`
 * saying what it did.
 *
 * Every message goes out through the site's email (`ctx.email`), the same
 * path the forms plugin's notifications take. While the site has no email
 * provider nothing is sent: messages wait, and the form says so.
 *
 * @example
 * ```typescript
 * import { subscriptionsPlugin } from "@emdash-cms/plugin-subscriptions";
 *
 * emdash({ plugins: [subscriptionsPlugin({ postPath: "/posts/{slug}" })] });
 * ```
 *
 * The form posts `email` (and `source`, the page's path, and `fragment`, the
 * form's id, to come back to) to `/_emdash/api/plugins/emdash-subscriptions/subscribe`.
 */

import type { PluginContext, PluginDescriptor, ResolvedPlugin, RouteContext } from "emdash";
import { definePlugin, pluginResponse } from "emdash";

import { adminPage } from "./admin.js";
import {
	backTo,
	confirm,
	confirmedCount,
	drain,
	excerptOf,
	fragmentOf,
	pageOf,
	PLUGIN_ID,
	queueNewPost,
	subscribe,
	type SubscriptionsEnv,
	unsubscribe,
} from "./subscriptions.js";

export type { ImportReport, OutboxMessage, Subscriber } from "./subscriptions.js";

export interface SubscriptionsPluginOptions {
	/** Where a post is on the site, `{slug}` its slug: the link each new-post email carries. */
	postPath?: string;
	/** The collection whose published entries go out. */
	collection?: string;
}

const VERSION = "0.1.0";

const STORAGE = {
	subscribers: { indexes: ["status", "createdAt"] as const },
	outbox: { indexes: ["status", "subscriber", "createdAt", ["status", "createdAt"]] as const },
};

export function subscriptionsPlugin(
	options: SubscriptionsPluginOptions = {},
): PluginDescriptor<SubscriptionsPluginOptions> {
	return {
		id: PLUGIN_ID,
		version: VERSION,
		entrypoint: "@emdash-cms/plugin-subscriptions",
		options,
		capabilities: ["email:send", "content:read"],
		adminPages: [{ path: "/", label: "Subscribers", icon: "envelope" }],
		storage: {
			subscribers: { indexes: ["status", "createdAt"] },
			outbox: { indexes: ["status", "subscriber", "createdAt"] },
		},
	};
}

/** Where the site answers, remembered from the last request, for a hook or a cron that has none. */
const ORIGIN_KEY = "state:origin";

/**
 * What the plugin reaches, from a hook's or a route's context. The site's
 * address is its URL setting, else the address a visitor reached it at (a
 * route's request), else the one remembered from the last request: an email's
 * links must be absolute.
 */
async function envOf(ctx: PluginContext, request?: Request): Promise<SubscriptionsEnv> {
	const reached = !ctx.site.url && request ? new URL(request.url).origin : "";
	const kept = ctx.site.url ? "" : ((await ctx.kv.get<string>(ORIGIN_KEY)) ?? "");
	if (reached && reached !== kept) await ctx.kv.set(ORIGIN_KEY, reached);
	const origin = ctx.site.url || reached || kept;
	return {
		subscribers: ctx.storage.subscribers as SubscriptionsEnv["subscribers"],
		outbox: ctx.storage.outbox as SubscriptionsEnv["outbox"],
		kv: ctx.kv,
		...(ctx.email ? { email: ctx.email } : {}),
		site: { name: ctx.site.name, url: origin },
		url: (path) => (origin ? new URL(path, origin).href : path),
		log: ctx.log,
		now: () => new Date(),
	};
}

/** A route's answer: back to the site's page, with what it did. */
const redirect = (location: string) =>
	pluginResponse({ status: 303, headers: { location, "cache-control": "no-store" } });

/** A form post's text fields. */
function formFields(input: unknown): Record<string, string> {
	const entries =
		(input as { entries?: Array<{ name: string; kind: string; value?: unknown }> })?.entries ?? [];
	const out: Record<string, string> = {};
	for (const e of entries)
		if (e.kind === "text" && typeof e.value === "string") out[e.name] ??= e.value;
	return out;
}

export function createPlugin(options: SubscriptionsPluginOptions = {}): ResolvedPlugin {
	const postPath = options.postPath ?? "/posts/{slug}";
	const collection = options.collection ?? "posts";
	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: ["email:send", "content:read"],
		storage: STORAGE,

		hooks: {
			"plugin:activate": {
				handler: async (_event, ctx) => {
					// What waits in the outbox goes out once the site can send.
					if (ctx.cron) await ctx.cron.schedule("drain", { schedule: "*/5 * * * *" });
				},
			},
			cron: {
				handler: async (event, ctx) => {
					if (event.name === "drain") await drain(await envOf(ctx));
				},
			},
			"content:afterPublish": {
				handler: async (event, ctx) => {
					if (event.collection !== collection) return;
					const c = event.content as {
						id?: unknown;
						slug?: unknown;
						publishedAt?: unknown;
						data?: Record<string, unknown>;
					};
					const data = c.data ?? {};
					const published =
						c.publishedAt instanceof Date
							? c.publishedAt
							: typeof c.publishedAt === "string"
								? new Date(c.publishedAt)
								: null;
					const env = await envOf(ctx);
					const queued = await queueNewPost(
						env,
						{
							id: typeof c.id === "string" ? c.id : "",
							slug: typeof c.slug === "string" && c.slug !== "" ? c.slug : null,
							title: typeof data.title === "string" ? data.title : "",
							excerpt: excerptOf(data),
							publishedAt: published,
						},
						(slug) => postPath.replace("{slug}", encodeURIComponent(slug)),
					);
					if (queued > 0) await drain(env);
				},
			},
		},

		routes: {
			// --- Public: the site's form, and the links its emails carry ---

			subscribe: {
				public: true,
				methods: ["POST"],
				request: { body: "form-data", maxBytes: 16 * 1024 },
				response: "raw",
				handler: async (ctx: RouteContext) => {
					const f = formFields(ctx.input);
					const page = pageOf(f.source);
					const fragment = fragmentOf(f.fragment);
					let status: Awaited<ReturnType<typeof subscribe>>;
					try {
						status = await subscribe(await envOf(ctx, ctx.request), {
							email: f.email,
							page,
							...(fragment ? { fragment } : {}),
							honeypot: f.website,
						});
					} catch (error) {
						ctx.log.error("a subscription could not be stored", {
							error: error instanceof Error ? error.message : String(error),
						});
						status = "error";
					}
					return redirect(backTo(page, status, fragment));
				},
			},

			confirm: {
				public: true,
				methods: ["GET"],
				response: "raw",
				handler: async (ctx: RouteContext) => {
					const { status, page, fragment } = await confirm(
						await envOf(ctx, ctx.request),
						ctx.input as Record<string, unknown>,
					);
					return redirect(backTo(page, status, fragment));
				},
			},

			unsubscribe: {
				public: true,
				methods: ["GET"],
				response: "raw",
				handler: async (ctx: RouteContext) => {
					const { status, page, fragment } = await unsubscribe(
						await envOf(ctx, ctx.request),
						ctx.input as Record<string, unknown>,
					);
					return redirect(backTo(page, status, fragment));
				},
			},

			/** The count the site's sign-up says: confirmed subscribers, as Jetpack's line counts them. */
			status: {
				public: true,
				methods: ["GET"],
				handler: async (ctx: RouteContext) => ({
					// a count needs no address: a page view writes nothing
					confirmed: await confirmedCount(await envOf(ctx)),
				}),
			},

			// --- Admin: the Subscribers page (Block Kit) ---

			admin: {
				handler: async (ctx: RouteContext) => adminPage(await envOf(ctx, ctx.request), ctx.input),
			},
		},

		admin: {
			pages: [{ path: "/", label: "Subscribers", icon: "envelope" }],
		},
	});
}

export default createPlugin;
export type { SubscriptionsEnv };
