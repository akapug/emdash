import { describe, expect, it, vi } from "vitest";

import { parseCsv } from "../src/csv.js";
import {
	backTo,
	confirm,
	confirmedCount,
	drain,
	DRAIN_SCHEDULE,
	DRAIN_TASK,
	excerptOf,
	fragmentOf,
	importSubscribers,
	linkToken,
	pageOf,
	queueNewPost,
	subscribe,
	subscriberId,
	unsubscribe,
	type OutboxMessage,
	type Subscriber,
	type SubscriptionsEnv,
} from "../src/subscriptions.js";

/** A storage collection kept in a Map, with the where/orderBy/limit/cursor the plugin uses. */
function collection<T extends object>() {
	const rows = new Map<string, T>();
	const matches = (data: T, where: Record<string, unknown> = {}) =>
		Object.entries(where).every(([k, v]) => (data as Record<string, unknown>)[k] === v);
	return {
		rows,
		get: async (id: string) => rows.get(id) ?? null,
		put: async (id: string, data: T) => void rows.set(id, data),
		delete: async (id: string) => rows.delete(id),
		deleteMany: async (ids: string[]) => ids.filter((id) => rows.delete(id)).length,
		compareAndSet: async (id: string, expected: string | null, data: T) => {
			if (expected !== null || rows.has(id)) return { applied: false as const };
			rows.set(id, data);
			return { applied: true as const, revision: "1" };
		},
		count: async (where?: Record<string, unknown>) =>
			[...rows.values()].filter((d) => matches(d, where)).length,
		query: async (
			o: {
				where?: Record<string, unknown>;
				orderBy?: Record<string, "asc" | "desc">;
				limit?: number;
				cursor?: string;
			} = {},
		) => {
			let items = [...rows.entries()]
				.filter(([, d]) => matches(d, o.where))
				.map(([id, data]) => ({ id, data }));
			const [field, dir] = Object.entries(o.orderBy ?? {})[0] ?? [];
			if (field)
				items.sort(
					(a, b) =>
						String((a.data as Record<string, unknown>)[field]).localeCompare(
							String((b.data as Record<string, unknown>)[field]),
						) * (dir === "desc" ? -1 : 1),
				);
			const start = o.cursor ? Number(o.cursor) : 0;
			const limit = o.limit ?? 50;
			const page = items.slice(start, start + limit);
			return {
				items: page,
				hasMore: start + limit < items.length,
				...(start + limit < items.length ? { cursor: String(start + limit) } : {}),
			};
		},
	};
}

function kv() {
	const values = new Map<string, unknown>();
	return {
		values,
		get: async <T>(key: string) => (values.has(key) ? (values.get(key) as T) : null),
		set: async (key: string, value: unknown) => void values.set(key, value),
		delete: async (key: string) => values.delete(key),
		compareAndSet: async (key: string, expected: string | null, value: unknown) => {
			if (expected !== null || values.has(key)) return { applied: false as const };
			values.set(key, value);
			return { applied: true as const, revision: "1" };
		},
	};
}

const NOW = new Date("2026-09-28T17:00:00.000Z");

/** The plugin's scheduled tasks, as EmDash's cron keeps them: one per name, a second schedule replacing the first. */
function cron() {
	const tasks = new Map<string, string>();
	return {
		tasks,
		schedule: vi.fn(async (name: string, o: { schedule: string }) => void tasks.set(name, o.schedule)),
		cancel: vi.fn(async (name: string) => void tasks.delete(name)),
		list: vi.fn(async () =>
			[...tasks].map(([name, schedule]) => ({ name, schedule, nextRunAt: "", lastRunAt: null })),
		),
	};
}

function site(opts: { mail?: boolean; failing?: boolean } = {}) {
	const subscribers = collection<Subscriber>();
	const outbox = collection<OutboxMessage>();
	const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
	const send = vi.fn(async (m: { to: string; subject: string; text: string; html: string }) => {
		if (opts.failing) throw new Error("the provider refused");
		sent.push(m);
	});
	const tasks = cron();
	const env = {
		subscribers,
		outbox,
		kv: kv(),
		cron: tasks,
		...(opts.mail ? { email: { send } } : {}),
		site: { name: "Example Site", url: "https://example.org" },
		url: (path: string) => new URL(path, "https://example.org").href,
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		now: () => NOW,
	} as unknown as SubscriptionsEnv;
	return { env, subscribers, outbox, sent, send, cron: tasks };
}

const linkIn = (text: string, action: string) => {
	const m = new RegExp(
		`https://example\\.org/_emdash/api/plugins/emdash-subscriptions/${action}\\?s=([0-9a-f]+)&t=([0-9a-f]+)`,
	).exec(text);
	return m ? { s: m[1], t: m[2] } : null;
};

describe("a visitor subscribes on the site's form", () => {
	it("stores a pending subscription with the consent it came with and nothing else, and sends nothing while the site has no email", async () => {
		const { env, subscribers, outbox, send } = site();
		const status = await subscribe(env, {
			email: " Reader@Example.ORG ",
			page: "/about/",
			fragment: "subscribe-blog-1",
		});
		expect(status).toBe("saved");
		expect(subscribers.rows.size).toBe(1);
		const [row] = [...subscribers.rows.values()];
		expect(row).toEqual({
			email: "reader@example.org",
			status: "pending",
			createdAt: NOW.toISOString(),
			consent: { source: "form", site: "example.org", page: "/about/", at: NOW.toISOString() },
			fragment: "subscribe-blog-1",
		});
		// one confirmation waits, keyed to the subscriber's id, which is not the address
		expect(Array.from(outbox.rows.values(), (m) => [m.kind, m.status])).toEqual([
			["confirm", "queued"],
		]);
		expect([...subscribers.rows.keys()][0]).toMatch(/^[0-9a-f]{32}$/);
		expect(JSON.stringify([...outbox.rows.values()])).not.toContain("reader@");
		expect(send).not.toHaveBeenCalled();
	});

	it("sends the confirmation at once when the site can send, with a link that confirms", async () => {
		const { env, subscribers, outbox, sent } = site({ mail: true });
		expect(await subscribe(env, { email: "reader@example.org", page: "/" })).toBe("sent");
		expect(sent).toHaveLength(1);
		expect(sent[0]!.to).toBe("reader@example.org");
		expect(sent[0]!.subject).toBe("Confirm your subscription to Example Site");
		expect(outbox.rows.size).toBe(0);
		const l = linkIn(sent[0]!.text, "confirm")!;
		expect(await confirm(env, l)).toEqual({ status: "confirmed", page: "/" });
		expect([...subscribers.rows.values()][0]!.status).toBe("confirmed");
		expect([...subscribers.rows.values()][0]!.confirmedAt).toBe(NOW.toISOString());
	});

	it("keeps the confirmation to send again when sending fails, and says so", async () => {
		const { env, outbox } = site({ mail: true, failing: true });
		expect(await subscribe(env, { email: "reader@example.org", page: "/" })).toBe("queued");
		expect(Array.from(outbox.rows.values(), (m) => [m.status, m.attempts])).toEqual([
			["queued", 1],
		]);
	});

	it("tells a second try what the first did: waiting to confirm, or subscribed", async () => {
		const quiet = site();
		await subscribe(quiet.env, { email: "reader@example.org", page: "/" });
		expect(await subscribe(quiet.env, { email: "READER@example.org", page: "/" })).toBe(
			"pending_saved",
		);
		expect(quiet.outbox.rows.size).toBe(1);
		const live = site({ mail: true });
		await subscribe(live.env, { email: "reader@example.org", page: "/" });
		expect(await subscribe(live.env, { email: "reader@example.org", page: "/" })).toBe("pending");
		await confirm(live.env, linkIn(live.sent[0]!.text, "confirm")!);
		expect(await subscribe(live.env, { email: "reader@example.org", page: "/" })).toBe("already");
		expect(live.sent).toHaveLength(1);
	});

	it("sends a second try the confirmation that never went, and says 'check your inbox' only of one that did", async () => {
		// saved while the site could not send; the site can send now
		const quiet = site();
		await subscribe(quiet.env, { email: "reader@example.org", page: "/" });
		(quiet.env as { email?: unknown }).email = { send: quiet.send };
		expect(await subscribe(quiet.env, { email: "reader@example.org", page: "/" })).toBe("sent");
		expect(quiet.sent.map((m) => m.to)).toEqual(["reader@example.org"]);
		expect(quiet.outbox.rows.size).toBe(0);
		// given up on after five failed tries; the provider works again
		const opts = { mail: true, failing: true };
		const flaky = site(opts);
		await subscribe(flaky.env, { email: "reader@example.org", page: "/" });
		for (let i = 0; i < 5; i++) await drain(flaky.env);
		expect([...flaky.outbox.rows.values()].map((m) => m.status)).toEqual(["failed"]);
		expect(await subscribe(flaky.env, { email: "reader@example.org", page: "/" })).toBe("queued");
		opts.failing = false;
		expect(await subscribe(flaky.env, { email: "reader@example.org", page: "/" })).toBe("sent");
		expect(flaky.sent).toHaveLength(1);
	});

	it("stores nothing for an address a message cannot go to, or a filled honeypot", async () => {
		const { env, subscribers, outbox } = site();
		for (const email of [
			"",
			"no-at-sign",
			"two@@example.org",
			"a b@example.org",
			"x@nodot",
			"<x>@example.org",
			42,
		])
			expect(await subscribe(env, { email, page: "/" })).toBe("invalid_email");
		expect(
			await subscribe(env, {
				email: "bot@example.org",
				page: "/",
				honeypot: "http://spam.example",
			}),
		).toBe("saved");
		expect(subscribers.rows.size).toBe(0);
		expect(outbox.rows.size).toBe(0);
	});
});

describe("the outbox's drain", () => {
	it("is put on the schedule by whatever queues a message, once, for a site whose config declares the plugin", async () => {
		// EmDash runs plugin:activate only when a plugin is turned on in the admin: nothing else schedules the drain.
		const { env, cron: tasks } = site();
		expect(tasks.tasks.size).toBe(0);
		await subscribe(env, { email: "one@example.org", page: "/" });
		expect([...tasks.tasks]).toEqual([[DRAIN_TASK, DRAIN_SCHEDULE]]);
		await subscribe(env, { email: "two@example.org", page: "/" });
		expect(tasks.schedule).toHaveBeenCalledTimes(1);
		// a new post puts it back when it has gone
		tasks.tasks.clear();
		await confirmed(env, "three@example.org");
		tasks.tasks.clear();
		expect(
			await queueNewPost(
				env,
				{ id: "p1", slug: "p1", title: "P1", excerpt: "", publishedAt: NOW },
				(slug) => `/posts/${slug}`,
			),
		).toBe(1);
		expect([...tasks.tasks]).toEqual([[DRAIN_TASK, DRAIN_SCHEDULE]]);
	});

	it("leaves the sign-up stored and its words true when the schedule cannot be written", async () => {
		const { env, subscribers, cron: tasks } = site();
		tasks.list.mockRejectedValueOnce(new Error("no table"));
		expect(await subscribe(env, { email: "one@example.org", page: "/" })).toBe("saved");
		expect(subscribers.rows.size).toBe(1);
	});
});

describe("the links an email carries", () => {
	it("refuse a link whose signature is not the site's, and change nothing", async () => {
		const { env, subscribers } = site();
		await subscribe(env, { email: "reader@example.org", page: "/" });
		const id = [...subscribers.rows.keys()][0]!;
		const good = await linkToken(env, "confirm", id);
		const forged = `${good.slice(0, 31)}${good.at(-1) === "0" ? "1" : "0"}`;
		expect(await confirm(env, { s: id, t: forged })).toMatchObject({ status: "invalid_link" });
		// a refused link goes to the home page: it says nothing of the page the address signed up on
		expect(await confirm(env, { s: id, t: await linkToken(env, "unsubscribe", id) })).toEqual({
			status: "invalid_link",
			page: "/",
		});
		expect(await unsubscribe(env, { s: id, t: good })).toMatchObject({ status: "invalid_link" });
		expect(await confirm(env, { s: "../x", t: good })).toMatchObject({ status: "invalid_link" });
		expect([...subscribers.rows.values()][0]!.status).toBe("pending");
		// another site's key signs other links
		const other = site();
		await subscribe(other.env, { email: "reader@example.org", page: "/" });
		expect(await confirm(other.env, { s: id, t: good })).toMatchObject({ status: "invalid_link" });
	});

	it("unsubscribe deletes the address and every message waiting for it", async () => {
		const { env, subscribers, outbox } = site();
		await subscribe(env, { email: "reader@example.org", page: "/about/", fragment: "sub-1" });
		const id = [...subscribers.rows.keys()][0]!;
		await confirm(env, { s: id, t: await linkToken(env, "confirm", id) });
		await queueNewPost(env, post("p1"), (s) => `/posts/${s}`);
		expect(outbox.rows.size).toBe(1);
		expect(await unsubscribe(env, { s: id, t: await linkToken(env, "unsubscribe", id) })).toEqual({
			status: "unsubscribed",
			page: "/about/",
			fragment: "sub-1",
		});
		expect(subscribers.rows.size).toBe(0);
		expect(outbox.rows.size).toBe(0);
		expect(await confirmedCount(env)).toBe(0);
	});
});

const post = (id: string, publishedAt: Date | null = NOW) => ({
	id,
	slug: `slug-${id}`,
	title: `Post ${id}`,
	excerpt: "What it says.",
	publishedAt,
});

async function confirmed(env: SubscriptionsEnv, email: string) {
	await subscribe(env, { email, page: "/" });
	const id = await subscriberId(env, email);
	await confirm(env, { s: id, t: await linkToken(env, "confirm", id) });
	return id;
}

describe("a new post", () => {
	it("queues exactly one message for each confirmed subscriber, and sends nothing while the site has no email", async () => {
		const { env, outbox, send } = site();
		const a = await confirmed(env, "a@example.org");
		const b = await confirmed(env, "b@example.org");
		await subscribe(env, { email: "pending@example.org", page: "/" });
		expect(await queueNewPost(env, post("p1"), (s) => `/posts/${s}`)).toBe(2);
		const posts = [...outbox.rows.values()].filter((m) => m.kind === "post");
		expect(posts.map((m) => m.subscriber).toSorted()).toEqual([a, b].toSorted());
		expect(posts[0]!.post).toEqual({
			id: "p1",
			title: "Post p1",
			url: "/posts/slug-p1",
			excerpt: "What it says.",
		});
		// published again (unpublished, then published): not new
		expect(await queueNewPost(env, post("p1"), (s) => `/posts/${s}`)).toBe(0);
		expect([...outbox.rows.values()].filter((m) => m.kind === "post")).toHaveLength(2);
		expect(await drain(env)).toBe(0);
		expect(send).not.toHaveBeenCalled();
	});

	it("is not sent when it was published before the last day: an imported or backdated post", async () => {
		const { env, outbox } = site();
		await confirmed(env, "a@example.org");
		expect(
			await queueNewPost(env, post("old", new Date("2023-07-05T12:00:00Z")), (s) => `/posts/${s}`),
		).toBe(0);
		expect(await queueNewPost(env, post("none", null), (s) => `/posts/${s}`)).toBe(0);
		expect([...outbox.rows.values()].filter((m) => m.kind === "post")).toHaveLength(0);
	});

	it("goes out through the site's email once it can send: one email each, with a link that unsubscribes", async () => {
		const { env, sent, outbox } = site({ mail: true });
		await confirmed(env, "a@example.org");
		sent.length = 0;
		await queueNewPost(env, post("p2"), (s) => `/posts/${s}`);
		expect(await drain(env)).toBe(1);
		expect(sent.map((m) => [m.to, m.subject])).toEqual([
			["a@example.org", "[Example Site] Post p2"],
		]);
		expect(sent[0]!.text).toContain("Read more: https://example.org/posts/slug-p2");
		expect(linkIn(sent[0]!.text, "unsubscribe")).not.toBeNull();
		expect(outbox.rows.size).toBe(0);
	});

	it("gives a message up after five failed tries", async () => {
		const { env, outbox } = site({ mail: true, failing: true });
		await subscribe(env, { email: "a@example.org", page: "/" });
		for (let i = 0; i < 6; i++) await drain(env);
		expect(Array.from(outbox.rows.values(), (m) => [m.status, m.attempts])).toEqual([
			["failed", 5],
		]);
	});
});

describe("the list WordPress kept, imported", () => {
	it("makes each address a confirmed subscriber with its consent recorded as imported, and sends nothing", async () => {
		const { env, subscribers, outbox, send } = site({ mail: true });
		await confirmed(env, "already@example.org");
		await subscribe(env, { email: "pending@example.org", page: "/", fragment: "f" });
		send.mockClear();
		const csv = [
			"email_address,subscription_date,status",
			"new@example.org,2021-05-04 10:00:00,active",
			'"quoted@example.org","2022-01-02",subscribed',
			"not-an-address,2022-01-02,active",
			"gone@example.org,2020-01-01,unsubscribed",
			"waiting@example.org,2020-01-01,pending",
			"ALREADY@example.org,2020-01-01,active",
			"pending@example.org,2020-01-01,active",
		].join("\r\n");
		const report = await importSubscribers(env, csv);
		expect(report).toEqual({
			rows: 7,
			imported: 2,
			confirmed: 1,
			already: 1,
			invalid: 1,
			notSubscribed: { unsubscribed: 1, pending: 1 },
		});
		const imported = subscribers.rows.get(await subscriberId(env, "new@example.org"))!;
		expect(imported.status).toBe("confirmed");
		expect(imported.consent).toEqual({
			source: "import",
			site: "example.org",
			at: NOW.toISOString(),
			subscribedAt: "2021-05-04T10:00:00.000Z",
		});
		expect(subscribers.rows.get(await subscriberId(env, "pending@example.org"))!.status).toBe(
			"confirmed",
		);
		expect(subscribers.rows.has(await subscriberId(env, "gone@example.org"))).toBe(false);
		expect([...outbox.rows.values()].filter((m) => m.kind === "confirm")).toHaveLength(0);
		expect(send).not.toHaveBeenCalled();
		expect(await confirmedCount(env)).toBe(4);
	});

	it("refuses a file with no column of addresses, and takes the one column of them when no header names it", async () => {
		const { env } = site();
		expect((await importSubscribers(env, "name,city\nAda,London\n")).refused).toMatch(/no column/);
		expect(
			await importSubscribers(env, "Subscriber;Joined\nada@example.org;2020-01-01\n"),
		).toMatchObject({ imported: 1 });
	});
});

describe("where the visitor is sent back to", () => {
	it("is a path of the site's own, with what the try did and the form's id", () => {
		expect(pageOf("/2023/07/")).toBe("/2023/07/");
		for (const bad of [
			"https://evil.example/",
			"//evil.example/",
			"/\\evil.example",
			"/a?b=c",
			"/a#b",
			"",
			7,
		])
			expect(pageOf(bad)).toBe("/");
		expect(fragmentOf("subscribe-blog-blog_subscription-3")).toBe(
			"subscribe-blog-blog_subscription-3",
		);
		expect(fragmentOf('x" onclick')).toBeUndefined();
		expect(backTo("/about/", "saved", "sub-1")).toBe("/about/?subscribe=saved#sub-1");
	});
});

describe("a post's excerpt in its email", () => {
	it("is its own, or its first 55 words", () => {
		expect(excerptOf({ excerpt: " Its own. " })).toBe("Its own.");
		const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
		expect(excerptOf({ content: [{ _type: "block", children: [{ text: words }] }] })).toBe(
			`${words.split(" ").slice(0, 55).join(" ")} […]`,
		);
	});
});

describe("a CSV file", () => {
	it("reads quoted fields, doubled quotes, line breaks in quotes, and the header's delimiter", () => {
		expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",z\n\n')).toEqual([
			["a", "b"],
			["x, y", 'say "hi"'],
			["two\nlines", "z"],
		]);
		expect(parseCsv("a;b\n1;2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		expect(parseCsv("a\tb\n1\t2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});
});
