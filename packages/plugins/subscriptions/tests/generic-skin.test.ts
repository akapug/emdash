/**
 * The generic sign-up skin (the blog template's renderWpShellSubscribe, for a
 * site Embark cut from a slot map, a Substack's sign-up among them) posts to
 * this plugin's subscribe route. What a browser posts from the drawn skin is
 * handed to the route, the site's email a stub that sends nothing: an address
 * the plugin accepts dispatches exactly one confirmation, one it refuses (not
 * an address, or the honeypot filled) none, and drawing the skin none.
 */
import { describe, expect, it, vi } from "vitest";

import {
	renderWpShellSubscribe,
	type WpShellSubscribe,
} from "../../../../templates/blog-cloudflare/src/utils/wp-shell";
import { createPlugin } from "../src/index.js";
import type { OutboxMessage, Subscriber } from "../src/subscriptions.js";
import { collection, cron, kv } from "./fakes.js";

const SITE = "https://site.test";
const ACTION = "/_emdash/api/plugins/emdash-subscriptions/subscribe";

/** The skin as Embark's writer cuts one from a Substack's sign-up: its markup, EmDash's form in it. */
const SKIN: WpShellSubscribe = {
	plugin: "generic",
	parts: [
		'<div class="subscribe-widget">',
		{ s: "form", class: "form" },
		{ s: "fields" },
		{ s: "/form" },
		"</div>",
	],
	fields: [
		{ s: "control", class: "email-input", placeholder: "Type your email..." },
		{ s: "submit", tag: "button", class: "button primary", label: "Subscribe" },
	],
};

/** One site: its plugin, storage in memory, and an email stub that records what it is asked to send. */
function site() {
	const plugin = createPlugin();
	const subscribers = collection<Subscriber>();
	const outbox = collection<OutboxMessage>();
	const store = kv();
	const tasks = cron();
	const send = vi.fn(async (_m: { to: string; subject: string; text: string; html: string }) => {});
	const ctxOf = (request: Request, input: unknown) => ({
		input,
		request,
		storage: { subscribers, outbox },
		kv: store,
		cron: tasks,
		site: { name: "Example Site", url: SITE, locale: "en" },
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		email: { send },
	});
	/** The skin on the page at `path`, filled as the template's layout fills it from the plugin's status route. */
	async function draw(path: string) {
		const url = new URL(path, SITE);
		const status = (await plugin.routes.status!.handler(
			ctxOf(new Request(new URL(ACTION.replace(/subscribe$/, "status"), SITE)), {}) as never,
		)) as { confirmed: number };
		return renderWpShellSubscribe(SKIN, {
			action: ACTION,
			source: url.pathname,
			status: url.searchParams.get("subscribe"),
			count: status.confirmed,
		});
	}
	/** What a browser posts from the drawn form, `fill` typed in, handed to the route its action names. */
	async function submit(html: string, fill: Record<string, string>) {
		const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html);
		if (!form) throw new Error("the skin drew no form");
		const action = /\saction="([^"]*)"/.exec(form[1]!)?.[1] ?? "";
		const [, pluginId, routeName] = /^\/_emdash\/api\/plugins\/([^/]+)\/(.+)$/.exec(action) ?? [];
		const route = pluginId === plugin.id ? plugin.routes[routeName!] : undefined;
		if (!route) throw new Error(`the skin posts to ${action}, which is no route of the plugin`);
		const entries: Array<{ name: string; kind: "text"; value: string }> = [];
		for (const [, tag] of form[2]!.matchAll(/<input\b([^>]*)>/g)) {
			const name = /\sname="([^"]*)"/.exec(tag!)?.[1];
			const type = /\stype="([^"]*)"/.exec(tag!)?.[1];
			const value = /\svalue="([^"]*)"/.exec(tag!)?.[1] ?? "";
			if (name)
				entries.push({
					name,
					kind: "text",
					value: type === "email" ? (fill.email ?? "") : (fill[name] ?? value),
				});
		}
		const res = (await route.handler(
			ctxOf(new Request(new URL(action, SITE), { method: "POST" }), { entries }) as never,
		)) as { status: number; headers: Array<[string, string]> };
		return {
			route,
			names: entries.map((e) => e.name),
			status: res.status,
			location: new Map(res.headers).get("location") ?? "",
		};
	}
	return { draw, submit, send, subscribers, outbox };
}

describe("the generic sign-up skin, submitted to the plugin", () => {
	it("posts the page, the honeypot and the address to the plugin's public form route, and drawing it sends nothing", async () => {
		const s = site();
		const html = await s.draw("/about");
		const { route, names } = await s.submit(html, { email: "" });
		expect(route.public).toBe(true);
		expect(route.methods).toEqual(["POST"]);
		expect(route.request).toMatchObject({ body: "form-data" });
		expect(names).toEqual(["source", "website", "email"]);
		expect(s.send).not.toHaveBeenCalled();
	});

	it("dispatches exactly one confirmation for an address the plugin accepts, and none for the same address again", async () => {
		const s = site();
		const html = await s.draw("/about");
		const first = await s.submit(html, { email: "Reader@Example.org" });
		expect(first.status).toBe(303);
		expect(first.location).toBe("/about?subscribe=sent");
		expect(s.send).toHaveBeenCalledTimes(1);
		expect(s.send.mock.calls[0]![0].to).toBe("reader@example.org");
		expect(s.send.mock.calls[0]![0].text).toContain(
			`${SITE}/_emdash/api/plugins/emdash-subscriptions/confirm?s=`,
		);
		expect([...s.subscribers.rows.values()]).toMatchObject([
			{
				email: "reader@example.org",
				status: "pending",
				consent: { source: "form", page: "/about" },
			},
		]);
		// The page it comes back to says so in the skin's own status line, and draws no form again.
		const back = await s.draw(first.location);
		expect(back).toContain('class="wp-shell-subscribe-status wp-shell-subscribe-ok" role="status"');
		expect(back).not.toContain('name="email"');
		expect((await s.submit(html, { email: "reader@example.org" })).location).toBe(
			"/about?subscribe=pending",
		);
		expect(s.send).toHaveBeenCalledTimes(1);
	});

	it.each([
		["not an address", { email: "not an address" }, "invalid_email"],
		["no address", { email: "" }, "invalid_email"],
		["an address whose domain has no dot", { email: "reader@localhost" }, "invalid_email"],
		[
			"the honeypot filled",
			{ email: "reader@example.org", website: "https://spam.example" },
			"sent",
		],
	])("dispatches none and stores nothing for %s", async (_, fill, status) => {
		const s = site();
		const { location } = await s.submit(await s.draw("/about"), fill);
		expect(location).toBe(`/about?subscribe=${status}`);
		expect(s.send).not.toHaveBeenCalled();
		expect(s.subscribers.rows.size).toBe(0);
		expect(s.outbox.rows.size).toBe(0);
	});
});
