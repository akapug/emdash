/**
 * The sign-up block (`emdash-subscribe`) is a form that works with no script:
 * its markup posts the fields the plugin's subscribe route reads to that
 * route, and the page the route sends the visitor back to says what the
 * route did. Its heading and button say plain words when the block has none.
 *
 * The form is read from the rendered markup, as a browser reads it, and what
 * a browser would post is handed to the plugin's own route.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import { blockComponents } from "../src/astro/index.js";
import Subscribe from "../src/astro/Subscribe.astro";
import SubscribeEmbed from "../src/astro/SubscribeEmbed.astro";
import { createPlugin } from "../src/index.js";
import { fragmentOf, type OutboxMessage, type Subscriber } from "../src/subscriptions.js";
import { collection, cron, kv } from "./fakes.js";

const SITE = "https://site.test";
const BLOCK = { _type: "emdash-subscribe", _key: "k1" };

/**
 * The block drawn on the page at `url`. `origin` is the path the visitor
 * asked for when a layout rewrote it (Astro keeps it on the request).
 */
async function render(node: Record<string, unknown>, url = "/posts/hello", origin?: string) {
	const request = new Request(new URL(url, SITE));
	if (origin) Reflect.set(request, Symbol.for("astro.originPathname"), encodeURIComponent(origin));
	const container = await AstroContainer.create();
	return container.renderToString(SubscribeEmbed, { props: { node }, request });
}

const decode = (s: string) =>
	s
		.replace(/&quot;|&#34;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");

/** A tag's attributes, by name; a bare attribute is "". */
function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) out[m[1]!] = decode(m[2] ?? "");
	return out;
}

/** The one form: its attributes, its inputs' attributes, and its buttons. */
function formOf(html: string) {
	const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html);
	if (!form) return null;
	return {
		attrs: attrs(form[1]!),
		inputs: Array.from(form[2]!.matchAll(/<input\b([^>]*)>/g), (m) => attrs(m[1]!)),
		buttons: Array.from(form[2]!.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g), (m) => ({
			type: attrs(m[1]!).type,
			text: decode(m[2]!.trim()),
		})),
	};
}

const textOf = (html: string, cls: string) => {
	const m = new RegExp(`<p\\b[^>]*class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</p>`).exec(html);
	return m ? decode(m[1]!.trim()) : null;
};
const valueOf = (html: string, name: string) =>
	formOf(html)?.inputs.find((i) => i.name === name)?.value;

/**
 * What a browser posts from the form, with `email` typed in, handed to the
 * plugin's route that the form's action names. The body is read the way
 * EmDash's route wire reads a form post (core's route-wire.ts): its fields,
 * as text entries.
 */
async function submit(html: string, email: string, opts: { mail: boolean }) {
	const form = formOf(html);
	if (!form) throw new Error("the block drew no form");
	const body = new URLSearchParams();
	for (const input of form.inputs)
		if (input.name !== undefined)
			body.append(input.name, input.type === "email" ? email : (input.value ?? ""));
	const request = new Request(new URL(form.attrs.action!, SITE), {
		method: form.attrs.method!.toUpperCase(),
		body,
	});
	const [, pluginId, routeName] =
		/^\/_emdash\/api\/plugins\/([^/]+)\/(.+)$/.exec(form.attrs.action!) ?? [];
	const plugin = createPlugin();
	const route = pluginId === plugin.id ? plugin.routes[routeName!] : undefined;
	if (!route)
		throw new Error(`the form posts to ${form.attrs.action}, which is no route of the plugin`);
	const entries = Array.from((await request.formData()).entries(), ([name, value]) => ({
		name,
		kind: "text",
		value,
	}));
	const subscribers = collection<Subscriber>();
	const outbox = collection<OutboxMessage>();
	const sent: Array<{ to: string }> = [];
	const ctx = {
		input: { entries },
		request,
		storage: { subscribers, outbox },
		kv: kv(),
		cron: cron(),
		site: { name: "Example Site", url: SITE, locale: "en" },
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		...(opts.mail ? { email: { send: async (m: { to: string }) => void sent.push(m) } } : {}),
	};
	const res = (await route.handler(ctx as never)) as {
		status: number;
		headers: Array<[string, string]>;
	};
	return {
		route,
		status: res.status,
		location: new Map(res.headers).get("location") ?? "",
		subscribers: [...subscribers.rows.values()],
		sent,
	};
}

describe("the emdash-subscribe block is registered", () => {
	it("the site draws the block with the plugin's component", () => {
		expect(blockComponents).toEqual({ "emdash-subscribe": SubscribeEmbed });
	});
});

describe("the block's markup", () => {
	it("is a form with no script that posts the address, the page and the block's id to the plugin's subscribe route", async () => {
		const html = await render(BLOCK);
		expect(html).not.toMatch(/<script\b/i);
		const form = formOf(html)!;
		expect(form.attrs.method).toBe("post");
		expect(form.attrs.action).toBe("/_emdash/api/plugins/emdash-subscriptions/subscribe");
		// A plain form posts urlencoded, which the route's form-data body takes.
		expect(form.attrs.enctype).toBeUndefined();
		expect(form.inputs.map((i) => [i.name, i.type, i.value ?? null])).toEqual([
			["source", "hidden", "/posts/hello"],
			["fragment", "hidden", "subscribe-k1"],
			["website", "text", ""],
			["email", "email", null],
		]);
		expect(form.inputs.find((i) => i.name === "email")).toHaveProperty("required");
		expect(form.buttons.map((b) => b.type)).toEqual(["submit"]);
		// The route sends the visitor back to the block: its id is the fragment, and one the route keeps.
		expect(html).toMatch(/<div\b[^>]*\bid="subscribe-k1"/);
		expect(fragmentOf("subscribe-k1")).toBe("subscribe-k1");
	});

	it("posts to a public route that takes a form post", async () => {
		const { route } = await submit(await render(BLOCK), "reader@example.org", { mail: true });
		expect(route.public).toBe(true);
		expect(route.methods).toContain("POST");
		expect(route.request).toMatchObject({ body: "form-data" });
	});

	it("keeps a block's id to the characters the route takes back, at the length it takes", async () => {
		const odd = await render({ ...BLOCK, _key: "a.b c/../d" });
		expect(valueOf(odd, "fragment")).toBe("subscribe-abcd");
		const long = valueOf(await render({ ...BLOCK, _key: "k".repeat(200) }), "fragment")!;
		expect(fragmentOf(long)).toBe(long);
	});
});

describe("a visitor signs up on the block", () => {
	it("is stored pending with the page, sent a confirmation, and sent back to the block, which says an email was sent", async () => {
		const html = await render(BLOCK);
		const { status, location, subscribers, sent } = await submit(html, "reader@example.org", {
			mail: true,
		});
		expect(status).toBe(303);
		expect(location).toBe("/posts/hello?subscribe=sent#subscribe-k1");
		expect(subscribers).toMatchObject([
			{
				email: "reader@example.org",
				status: "pending",
				consent: { source: "form", page: "/posts/hello" },
				fragment: "subscribe-k1",
			},
		]);
		expect(sent.map((m) => m.to)).toEqual(["reader@example.org"]);

		const back = await render(BLOCK, location.split("#")[0]);
		expect(textOf(back, "ec-subscribe-message")).toContain("A confirmation email was sent to you");
		// Signed up: the form is not drawn again.
		expect(formOf(back)).toBeNull();
	});

	it("while the site cannot send email, the page says that no confirmation email was sent", async () => {
		const { location, subscribers, sent } = await submit(
			await render(BLOCK),
			"reader@example.org",
			{
				mail: false,
			},
		);
		expect(location).toBe("/posts/hello?subscribe=saved#subscribe-k1");
		expect(subscribers).toHaveLength(1);
		expect(sent).toEqual([]);
		const said = textOf(await render(BLOCK, location.split("#")[0]), "ec-subscribe-message");
		expect(said).toContain("no confirmation email was sent");
		expect(said).not.toContain("A confirmation email was sent");
	});

	it("an address that is not one is refused, and the page says so and draws the form again", async () => {
		const { location, subscribers } = await submit(await render(BLOCK), "not an address", {
			mail: true,
		});
		expect(location).toBe("/posts/hello?subscribe=invalid_email#subscribe-k1");
		expect(subscribers).toEqual([]);
		const back = await render(BLOCK, location.split("#")[0]);
		expect(textOf(back, "ec-subscribe-message")).toBe(
			"That email address is not valid. Please check it and try again.",
		);
		expect(formOf(back)).not.toBeNull();
	});

	it("says nothing for a status the plugin never gives", async () => {
		const html = await render(BLOCK, "/posts/hello?subscribe=anything");
		expect(textOf(html, "ec-subscribe-message")).toBeNull();
		expect(formOf(html)).not.toBeNull();
	});
});

describe("the page the visitor comes back to", () => {
	it("is the one they asked for when a layout rewrote it", async () => {
		const html = await render(BLOCK, "/wp-shell/posts/hello", "/posts/hello");
		expect(valueOf(html, "source")).toBe("/posts/hello");
	});

	it("keeps a path's escaped characters escaped, as a path the route takes", async () => {
		expect(valueOf(await render(BLOCK, "/posts/caf%C3%A9"), "source")).toBe("/posts/caf%C3%A9");
	});

	it("is written with no trailing slash, as the site writes its paths, and the home page is /", async () => {
		expect(valueOf(await render(BLOCK, "/posts/hello/"), "source")).toBe("/posts/hello");
		expect(valueOf(await render(BLOCK, "/"), "source")).toBe("/");
	});
});

describe("the block's heading and button", () => {
	it("say plain words when the block has none", async () => {
		const html = await render(BLOCK);
		expect(textOf(html, "ec-subscribe-heading")).toBe("Get new posts by email");
		expect(formOf(html)!.buttons.map((b) => b.text)).toEqual(["Subscribe"]);
	});

	it("say plain words when the block's are blank", async () => {
		const html = await render({ ...BLOCK, heading: "  ", button: "" });
		expect(textOf(html, "ec-subscribe-heading")).toBe("Get new posts by email");
		expect(formOf(html)!.buttons.map((b) => b.text)).toEqual(["Subscribe"]);
	});

	it("say the block's own words, as text", async () => {
		const html = await render({
			...BLOCK,
			heading: "Subscribe to <Example> & more",
			button: "Join",
		});
		expect(html).not.toContain("<Example>");
		expect(textOf(html, "ec-subscribe-heading")).toBe("Subscribe to <Example> & more");
		expect(formOf(html)!.buttons.map((b) => b.text)).toEqual(["Join"]);
	});
});

describe("Subscribe, outside content", () => {
	it("draws the same sign-up, named by its id", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Subscribe, {
			props: { id: "footer", button: "Join" },
			request: new Request(`${SITE}/about`),
		});
		expect(valueOf(html, "fragment")).toBe("subscribe-footer");
		expect(valueOf(html, "source")).toBe("/about");
		expect(textOf(html, "ec-subscribe-heading")).toBe("Get new posts by email");
		expect(formOf(html)!.buttons.map((b) => b.text)).toEqual(["Join"]);
	});
});
