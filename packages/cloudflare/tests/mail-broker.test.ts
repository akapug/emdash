/**
 * The mail broker (src/auth-mail/broker.ts): the one door a site's mail goes
 * out through, its generations, and its queue. Over a store the test holds, a
 * mail-budget double that speaks protocol 3 (tokens in generations, a take per
 * request id, a refund only by the token that took), and send bindings the
 * test can pause inside the send. tests/auth-mail.test.ts holds the four auth
 * operations themselves, and tests/mail-broker-workerd.test.ts runs the
 * broker's Worker, bundled by wrangler, in workerd.
 */

import { randomUUID } from "node:crypto";

import { AUTH_TABLES_SQL } from "@emdash-cms/auth/adapters/kysely";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	ANONYMOUS_WAITING_MAX,
	createMailBroker,
	sha256Hex,
	brokerConfigFromEnv,
	type BrokerStore,
	type MailBroker,
} from "../src/auth-mail/broker.js";
import {
	AUTH_MAIL_MARKER,
	AUTH_MAIL_PROTOCOL,
	type AuthMailTables,
} from "../src/auth-mail/mediator.js";

const P = AUTH_MAIL_PROTOCOL;
const ADMIN = "operator-secret-".padEnd(48, "x");
const SITE = {
	url: "https://acme.example.org",
	name: "Acme",
	from: "notifications@mail.example.net",
};
const ALLOWED = ["office@example.org", "sales@example.org", "admin@example.org"];
/** 32 random bytes, base64url: a capability or a budget token as the operator mints them. */
const secret = () =>
	btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

/** A generation's credentials: the site's capability and the broker's two budget tokens. */
const creds = () => ({ capability: secret(), plugin: secret(), system: secret() });
type Creds = ReturnType<typeof creds>;

function mapStore(map = new Map<string, unknown>()): BrokerStore & { map: Map<string, unknown> } {
	return {
		map,
		get: (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
		put: (key, value) => void map.set(key, structuredClone(value)),
		delete: (key) => void map.delete(key),
		keys: (prefix, limit) =>
			[...map.keys()]
				.filter((k) => k.startsWith(prefix))
				.toSorted()
				.slice(0, limit),
	};
}

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Let every queued microtask and timer of 0 run. */
const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A pause the test puts inside a call: `entered` when the call reached it, `release` to let it go on. */
function pause() {
	const entered = deferred();
	const release = deferred();
	return {
		entered: entered.promise,
		release: () => release.resolve(),
		at: entered,
		go: release.promise,
	};
}
type Pause = ReturnType<typeof pause>;

/** The mail budget in protocol 3: tokens registered to generations, each take kept, a take paused on demand. */
function fakeBudget(tenant = "acme") {
	const tokens = new Map<
		string,
		{ tenant: string; lane: string; generation: number; state: string }
	>();
	const takes: Array<Record<string, unknown>> = [];
	const refunds: Array<Record<string, unknown>> = [];
	const reports: Array<Record<string, unknown>> = [];
	const byRequest = new Map<string, { takeId: string; lane: string; generation: number }>();
	const made = new Map<string, { by: string; refunded: boolean }>();
	const holds: Pause[] = [];
	let lose = 0;
	let refundFails = 0;
	const service = {
		take: vi.fn(async (req: Record<string, unknown>) => {
			takes.push(req);
			const hold = holds.shift();
			if (hold) {
				hold.at.resolve();
				await hold.go;
			}
			const answer = (() => {
				if (req.protocol !== 3) return { ok: false, protocol: 3, scope: "protocol" };
				const t = tokens.get(String(req.token));
				if (!t) return { ok: false, protocol: 3, scope: "token" };
				if (t.state !== "active") return { ok: false, protocol: 3, scope: "generation" };
				const key = `${String(req.token)}:${String(req.requestId)}`;
				const seen = byRequest.get(key);
				if (seen) return { ok: true, protocol: 3, ...seen, replayed: true };
				const takeId = `2026-01-01:${randomUUID()}`;
				byRequest.set(key, { takeId, lane: t.lane, generation: t.generation });
				made.set(takeId, { by: String(req.token), refunded: false });
				return { ok: true, protocol: 3, takeId, lane: t.lane, generation: t.generation };
			})();
			// A take that committed, and whose answer is lost on the way back.
			if (lose > 0 && answer.ok) {
				lose--;
				throw new Error("the connection was lost");
			}
			return answer;
		}),
		refund: vi.fn(async (req: Record<string, unknown>) => {
			refunds.push(req);
			if (refundFails > 0) {
				refundFails--;
				throw new Error("the connection was lost");
			}
			// By the take's id, or, when its answer never came, by the request id it was asked with.
			const takeId =
				typeof req.takeId === "string"
					? req.takeId
					: byRequest.get(`${String(req.token)}:${String(req.requestId)}`)?.takeId;
			const r = takeId ? made.get(takeId) : undefined;
			if (!r || r.by !== req.token) return { ok: false, protocol: 3, scope: "take" };
			const was = r.refunded;
			r.refunded = true;
			return { ok: true, protocol: 3, refunded: was ? 0 : 1 };
		}),
		report: vi.fn(async (req: Record<string, unknown>) => {
			reports.push(req);
			const t = tokens.get(String(req.token));
			if (!t) return { ok: false, protocol: 3, scope: "token" };
			return { ok: true, protocol: 3, ...t, caps: {} };
		}),
	};
	return {
		service,
		takes,
		refunds,
		reports,
		tokens,
		counted: () => [...made.values()].filter((m) => !m.refunded).length,
		/** Retire the tenant's tokens and register this generation's STAGED, in one step. */
		stage(generation: number, c: Creds, forTenant = tenant) {
			for (const [k, v] of tokens) if (v.tenant === forTenant) tokens.delete(k);
			tokens.set(c.plugin, { tenant: forTenant, lane: "plugin", generation, state: "staged" });
			tokens.set(c.system, { tenant: forTenant, lane: "system", generation, state: "staged" });
		},
		activate(generation: number) {
			for (const v of tokens.values()) if (v.generation === generation) v.state = "active";
		},
		pauseTake() {
			const p = pause();
			holds.push(p);
			return p;
		},
		loseNextAnswer() {
			lose++;
		},
		/** The next `n` refunds are lost on the way (the budget is not reached, or its answer never comes). */
		failRefunds(n: number) {
			refundFails = n;
		},
	};
}
type Budget = ReturnType<typeof fakeBudget>;

/** A send_email binding: every message kept, a send paused or failed on demand. */
function sendBinding() {
	const sent: Array<Record<string, unknown>> = [];
	const holds: Pause[] = [];
	let fail: Error | null = null;
	const binding = {
		send: vi.fn(async (message: Record<string, unknown>) => {
			const hold = holds.shift();
			if (hold) {
				hold.at.resolve();
				await hold.go;
			}
			if (fail) {
				const e = fail;
				fail = null;
				throw e;
			}
			sent.push(message);
			return { messageId: `m-${sent.length}` };
		}),
	};
	return {
		sent,
		binding,
		pauseSend() {
			const p = pause();
			holds.push(p);
			return p;
		},
		failNext(e: Error) {
			fail = e;
		},
	};
}

interface Rig {
	b: MailBroker;
	store: ReturnType<typeof mapStore>;
	budget: Budget;
	plugin: ReturnType<typeof sendBinding>;
	system: ReturnType<typeof sendBinding>;
	db: Kysely<AuthMailTables> | null;
	sqlite: Database.Database | null;
	sessions: { get: ReturnType<typeof vi.fn> };
}

let open: Rig[] = [];
afterEach(async () => {
	for (const r of open) await r.db?.destroy();
	open = [];
});

/** An auth database with one admin, as tests/auth-mail.test.ts makes it. */
function authDb() {
	const sqlite = new Database(":memory:");
	for (const statement of AUTH_TABLES_SQL.split(";")
		.map((s) => s.trim())
		.filter(Boolean)) {
		sqlite.exec(statement);
	}
	sqlite.exec(
		`CREATE TABLE _emdash_rate_limits (key TEXT NOT NULL, "window" TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (key, "window"))`,
	);
	const now = new Date().toISOString();
	sqlite
		.prepare(
			"INSERT INTO users (id, email, name, role, email_verified, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
		)
		.run("u-admin", "admin@example.org", "Admin", 50, now, now);
	return {
		sqlite,
		db: new Kysely<AuthMailTables>({ dialect: new SqliteDialect({ database: sqlite }) }),
	};
}

function rig(
	over: {
		store?: ReturnType<typeof mapStore>;
		budget?: Budget;
		plugin?: ReturnType<typeof sendBinding>;
		system?: ReturnType<typeof sendBinding>;
		tenant?: string;
		auth?: boolean;
		/** The site's database of another rig: the same D1 behind a restarted object. */
		database?: ReturnType<typeof authDb>;
		adminSecret?: string | null;
	} = {},
): Rig {
	const store = over.store ?? mapStore();
	const budget = over.budget ?? fakeBudget();
	const plugin = over.plugin ?? sendBinding();
	const system = over.system ?? sendBinding();
	const { sqlite, db } =
		over.database ?? (over.auth ? authDb() : { sqlite: null, db: null });
	const sessions = { get: vi.fn(async () => null) };
	const b = createMailBroker({
		store,
		config: {
			tenant: over.tenant ?? "acme",
			deployment: "artifact-1:code-1",
			recipients: new Set(ALLOWED),
			site: SITE,
			adminSecret: over.adminSecret === undefined ? ADMIN : over.adminSecret,
			plugin: plugin.binding,
			system: system.binding,
			budget: budget.service,
		},
		db,
		sessions,
	});
	const r = { b, store, budget, plugin, system, db, sqlite, sessions };
	// A database shared with another rig is closed by that rig.
	if (!over.database) open.push(r);
	return r;
}

async function admin(b: MailBroker, verb: string, body?: unknown, auth = `Bearer ${ADMIN}`) {
	const r = await b.admin(
		new Request(`https://broker.example/admin/${verb}`, {
			method: body === undefined ? "GET" : "POST",
			headers: auth ? { authorization: auth } : {},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
	return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** The operator's lifecycle for generation `g`: the budget stages it, the broker stages and activates it, the budget activates it. */
async function bringUp(r: Rig, g: number, c: Creds, expectActive: number | null) {
	r.budget.stage(g, c);
	const staged = await admin(r.b, "stage", {
		generation: g,
		capabilityHash: await sha256Hex(c.capability),
		tokens: { plugin: c.plugin, system: c.system },
		expectActive,
	});
	expect(staged.status, JSON.stringify(staged.body)).toBe(200);
	const active = await admin(r.b, "activate", {
		generation: g,
		capabilityHash: await sha256Hex(c.capability),
		expectActive,
	});
	expect(active.status, JSON.stringify(active.body)).toBe(200);
	r.budget.activate(g);
	return active.body;
}

const message = (over: Record<string, unknown> = {}) => ({
	to: "office@example.org",
	subject: "New submission",
	text: "Someone wrote in.",
	...over,
});
const sendWith = (b: MailBroker, capability: string, over: Record<string, unknown> = {}) =>
	b.send({ protocol: P, capability, requestId: randomUUID(), message: message(), ...over });

describe("a send", () => {
	it("goes out through EMAIL_PLUGIN from the broker's own sender, after the plugin lane's take with the request's id", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		const requestId = randomUUID();
		const a = await r.b.send({
			protocol: P,
			capability: c.capability,
			requestId,
			message: message({ cc: ["sales@example.org"], replyTo: "visitor@elsewhere.example" }),
		});
		expect(a).toMatchObject({ protocol: P, status: "sent" });
		expect(r.plugin.sent).toEqual([
			{
				from: { email: SITE.from, name: "Acme" },
				to: "office@example.org",
				cc: ["sales@example.org"],
				subject: "New submission",
				text: "Someone wrote in.",
				replyTo: "visitor@elsewhere.example",
			},
		]);
		expect(r.system.sent).toEqual([]);
		expect(r.budget.takes).toHaveLength(1);
		expect(r.budget.takes[0]).toMatchObject({ protocol: 3, token: c.plugin, requestId });
		expect(r.budget.takes[0]!.recipients).toEqual([
			await sha256Hex("office@example.org"),
			await sha256Hex("sales@example.org"),
		]);
		expect(JSON.stringify(r.budget.takes)).not.toContain("@");
	});

	it("is exactly the envelope: a sender, a header, a bcc, a lane or anything else is refused before the budget is asked or anything is sent", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		for (const [key, value] of Object.entries({
			from: "ceo@example.org",
			sender: "x@example.org",
			headers: { "X-Evil": "1" },
			bcc: ["a@example.org"],
			system: true,
			lane: "system",
			token: c.plugin,
			tenant: "other",
			attachments: [],
		})) {
			expect(
				await sendWith(r.b, c.capability, { message: message({ [key]: value }) }),
				key,
			).toMatchObject({ status: "refused", why: expect.stringContaining(`takes no "${key}"`) });
		}
		for (const [key, value] of Object.entries({
			system: true,
			lane: "system",
			tenant: "other",
			token: c.system,
		})) {
			expect(await sendWith(r.b, c.capability, { [key]: value }), key).toMatchObject({
				status: "refused",
			});
		}
		for (const [what, over, why] of [
			[
				"two addresses in to",
				{ to: "office@example.org, sales@example.org" },
				/to is not one plain address/,
			],
			[
				"a header in to",
				{ to: "office@example.org\r\nBcc: x@example.org" },
				/to is not one plain address/,
			],
			["a cc that is not a list", { cc: "sales@example.org" }, /cc is not a list/],
			[
				"a cc that is not one address",
				{ cc: ["sales@example.org>"] },
				/a cc is not one plain address/,
			],
			[
				"a recipient off the list",
				{ to: "stranger@example.com" },
				/not on the broker's recipient list/,
			],
			["a cc off the list", { cc: ["stranger@example.com"] }, /not on the broker's recipient list/],
			["an empty subject", { subject: "\r\n\t" }, /subject is empty/],
			["text too long", { text: "x".repeat(300_000) }, /its text/],
			["html that is not text", { html: 5 }, /its html/],
		] as const) {
			expect(await sendWith(r.b, c.capability, { message: message(over) }), what).toMatchObject({
				status: "refused",
				why: expect.stringMatching(why),
			});
		}
		expect(
			await r.b.send({
				protocol: P,
				capability: c.capability,
				requestId: "short",
				message: message(),
			}),
		).toMatchObject({ status: "refused", why: expect.stringMatching(/request id/) });
		expect(
			await r.b.send({
				protocol: 1,
				capability: c.capability,
				requestId: randomUUID(),
				message: message(),
			}),
		).toMatchObject({ status: "refused", why: expect.stringMatching(/protocol/) });
		// A refused recipient's domain is named, never its address.
		expect(
			JSON.stringify(
				await sendWith(r.b, c.capability, { message: message({ to: "stranger@example.com" }) }),
			),
		).not.toContain("stranger@");
		expect(r.budget.takes).toEqual([]);
		expect(r.plugin.sent).toEqual([]);
		// The subject is header text, and a reply-to that is not one address is dropped.
		expect(
			await sendWith(r.b, c.capability, {
				message: message({
					subject: "Hi\r\nBcc: x@example.org",
					replyTo: "a@b.example, c@d.example",
				}),
			}),
		).toMatchObject({ status: "sent" });
		expect(r.plugin.sent[0]).toMatchObject({ subject: "Hi Bcc: x@example.org" });
		expect(r.plugin.sent[0]).not.toHaveProperty("replyTo");
	});

	it("with a request id seen already answers what it came to and sends nothing again, even when the first answer was lost", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		const request = {
			protocol: P,
			capability: c.capability,
			requestId: randomUUID(),
			message: message(),
		};
		const first = await r.b.send(request);
		expect(first).toMatchObject({ status: "sent" });
		expect(await r.b.send(request)).toEqual({ ...first, replayed: true });
		expect(r.plugin.sent).toHaveLength(1);
		expect(r.budget.takes).toHaveLength(1);
	});

	it("whose first attempt never finished (the object restarted inside the send) is not sent again, and is answered as not known to be sent, never as refused", async () => {
		const store = mapStore();
		const budget = fakeBudget();
		const first = rig({ store, budget });
		const c = creds();
		await bringUp(first, 1, c, null);
		const hold = first.plugin.pauseSend();
		const request = {
			protocol: P,
			capability: c.capability,
			requestId: randomUUID(),
			message: message(),
		};
		void first.b.send(request);
		await hold.entered;
		// The object is gone; a new one over the same storage gets the retry.
		const second = rig({ store, budget });
		// The first attempt's take stands and its message may have gone: a site that read
		// "refused" would give its own places back for mail that may be out.
		expect(await second.b.send(request)).toMatchObject({
			status: "unknown",
			why: expect.stringMatching(/did not finish: whether it was sent is not known/),
			replayed: true,
		});
		expect(second.plugin.sent).toEqual([]);
		expect(second.budget.takes).toHaveLength(1);
		expect(second.budget.refunds).toEqual([]);
		hold.release();
	});

	it("CURE 5: whose answer was lost before an activation gets that answer on its retry after it (sent, or unknown for one that never finished), never refused; only new work is held to the active generation, and another capability gets nothing of that request id", async () => {
		const store = mapStore();
		const budget = fakeBudget();
		const r = rig({ store, budget });
		const g0 = creds();
		const g1 = creds();
		await bringUp(r, 1, g0, null);
		const request = (capability: string) => ({
			protocol: P,
			capability,
			requestId: randomUUID(),
			message: message(),
		});
		// G0's send goes, and its answer is lost on the way back to the site.
		const lost = request(g0.capability);
		expect(await r.b.send(lost)).toMatchObject({ status: "sent" });
		// A second G0 send stops inside the binding: the object restarts there.
		const hold = r.plugin.pauseSend();
		const cut = request(g0.capability);
		void r.b.send(cut);
		await hold.entered;
		const after = rig({ store, budget });
		// The operator activates G1 in the new object: G0 is no longer the active generation.
		await bringUp(after, 2, g1, 1);
		// The site's retries of both, with G0's capability: what each came to, never "refused",
		// so the site keeps its places for mail that went or may have gone.
		expect(await after.b.send(lost)).toMatchObject({ status: "sent", replayed: true });
		expect(await after.b.send(cut)).toMatchObject({ status: "unknown", replayed: true });
		expect(after.budget.refunds).toEqual([]);
		// New work with G0's capability is refused, before anything is counted or sent.
		const takes = after.budget.takes.length;
		expect(await after.b.send(request(g0.capability))).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not this site's active generation's/),
		});
		expect(after.budget.takes).toHaveLength(takes);
		// Another capability naming G0's request id learns nothing of it and sends nothing.
		expect(await after.b.send({ ...lost, capability: g1.capability })).toMatchObject({
			status: "refused",
			why: "that request id was used with another capability",
		});
		expect(r.plugin.sent).toHaveLength(1);
		expect(after.plugin.sent).toEqual([]);
		hold.release();
	});

	it("whose take answered and whose answer was lost asks again with the same request id, and is counted once", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		r.budget.loseNextAnswer();
		expect(await sendWith(r.b, c.capability)).toMatchObject({ status: "sent" });
		expect(r.budget.takes).toHaveLength(2);
		expect(r.budget.takes[0]!.requestId).toBe(r.budget.takes[1]!.requestId);
		expect(r.budget.counted()).toBe(1);
		expect(r.plugin.sent).toHaveLength(1);
	});

	it("that EMAIL_PLUGIN refuses gives its place back with the token that took it, and says the binding's code, never an address", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		r.plugin.failNext(
			Object.assign(new Error("refused office@example.org"), { code: "E_RECIPIENT_NOT_ALLOWED" }),
		);
		const a = await sendWith(r.b, c.capability);
		expect(a).toMatchObject({
			status: "refused",
			why: "EMAIL_PLUGIN refused it (E_RECIPIENT_NOT_ALLOWED)",
		});
		expect(JSON.stringify(a)).not.toContain("office@");
		expect(r.budget.refunds).toEqual([
			{ protocol: 3, token: c.plugin, takeId: expect.any(String) },
		]);
		expect(r.budget.counted()).toBe(0);
	});

	it("counted to another lane or generation than the one its token is for is given back and not sent", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		// The budget holds the plugin token in the system lane (a misregistration): nothing is sent.
		r.budget.tokens.get(c.plugin)!.lane = "system";
		expect(await sendWith(r.b, c.capability)).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/"system" lane of generation 1, not the plugin lane of 1/),
		});
		r.budget.tokens.get(c.plugin)!.lane = "plugin";
		r.budget.tokens.get(c.plugin)!.generation = 7;
		expect(await sendWith(r.b, c.capability)).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/generation 7, not the plugin lane of 1/),
		});
		expect(r.budget.refunds).toHaveLength(2);
		expect(r.budget.counted()).toBe(0);
		expect(r.plugin.sent).toEqual([]);
	});
});

describe("a sign-in operation (CURE 4: its request id)", () => {
	it("whose first attempt stopped inside EMAIL_SYSTEM's send is answered unknown on its retry, never refused and never run again: no second token or message, and its place and its token stay", async () => {
		const store = mapStore();
		const budget = fakeBudget();
		const first = rig({ store, budget, auth: true });
		const database = { sqlite: first.sqlite!, db: first.db! };
		const c = creds();
		await bringUp(first, 1, c, null);
		const hold = first.system.pauseSend();
		const request = {
			protocol: P,
			capability: c.capability,
			requestId: randomUUID(),
			email: "admin@example.org",
			ip: null,
		};
		void first.b.requestMagicLink(request);
		await hold.entered;
		// The object stops inside the send; a new one over the same storage and database gets the site's retry.
		const second = rig({ store, budget, database });
		const tokens = () => database.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_tokens").get();
		expect(await second.b.requestMagicLink(request)).toMatchObject({
			status: "unknown",
			why: expect.stringMatching(/did not finish: whether it was sent is not known/),
			replayed: true,
		});
		// Nothing was run again: one take, no give-back, no second message, and the first link's token stays.
		expect(second.system.sent).toEqual([]);
		expect(budget.takes).toHaveLength(1);
		expect(budget.refunds).toEqual([]);
		expect(budget.counted()).toBe(1);
		expect(tokens()).toEqual({ n: 1 });
		hold.release();
	});

	it("whose answer was lost is answered what it came to on its retry, after an activation too; a new one with the old capability is refused, and another capability gets nothing of that request id", async () => {
		const r = rig({ auth: true });
		const g0 = creds();
		const g1 = creds();
		await bringUp(r, 1, g0, null);
		const request = {
			protocol: P,
			capability: g0.capability,
			requestId: randomUUID(),
			email: "admin@example.org",
			ip: null,
		};
		expect(await r.b.requestMagicLink(request)).toMatchObject({ status: "sent" });
		await bringUp(r, 2, g1, 1);
		expect(await r.b.requestMagicLink(request)).toMatchObject({ status: "sent", replayed: true });
		expect(r.system.sent).toHaveLength(1);
		expect(
			await r.b.requestMagicLink({ ...request, requestId: randomUUID() }),
		).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not this site's active generation's/),
		});
		expect(await r.b.requestMagicLink({ ...request, capability: g1.capability })).toMatchObject({
			status: "refused",
			why: "that request id was used with another capability",
		});
		// Without a request id nothing is run.
		const { requestId: _id, ...unnamed } = request;
		expect(
			await r.b.requestMagicLink({ ...unnamed, capability: g1.capability }),
		).toMatchObject({ status: "refused", why: expect.stringMatching(/names its request id/) });
		expect(r.system.sent).toHaveLength(1);
	});
});

describe("a capability", () => {
	it("counts only when it is the ACTIVE generation's: none, a malformed one, a staged one, a retired one or another site's is refused before anything is read, counted or sent", async () => {
		const r = rig({ auth: true });
		const g1 = creds();
		const g2 = creds();
		await bringUp(r, 1, g1, null);
		// Generation 2 staged in the budget and the broker, not active.
		r.budget.stage(2, g2);
		expect(
			(
				await admin(r.b, "stage", {
					generation: 2,
					capabilityHash: await sha256Hex(g2.capability),
					tokens: { plugin: g2.plugin, system: g2.system },
					expectActive: 1,
				})
			).status,
		).toBe(200);
		const takes = r.budget.takes.length;
		const reports = r.budget.reports.length;
		const cookie = "astro-session=0f8fad5b-d9cb-469f-a165-70867728950e";
		const refusedAll = async (capability: unknown, why: RegExp, what: string) => {
			expect(
				await r.b.send({ protocol: P, capability, requestId: randomUUID(), message: message() }),
				what,
			).toMatchObject({ status: "refused", why: expect.stringMatching(why) });
			for (const op of ["requestMagicLink", "requestSignup"] as const) {
				expect(
					await r.b[op]({
						protocol: P,
						capability,
						requestId: randomUUID(),
						email: "admin@example.org",
						ip: "203.0.113.1",
					}),
					`${op} ${what}`,
				).toMatchObject({ status: "refused", why: expect.stringMatching(why) });
			}
			expect(
				await r.b.createInvite({
					protocol: P,
					capability,
					requestId: randomUUID(),
					email: "new@example.org",
					role: 30,
					authorization: null,
					cookie,
				}),
				what,
			).toMatchObject({ status: "refused", why: expect.stringMatching(why) });
			expect(
				await r.b.sendRecovery({
					protocol: P,
					capability,
					requestId: randomUUID(),
					userId: "u-admin",
					authorization: null,
					cookie,
				}),
				what,
			).toMatchObject({ status: "refused", why: expect.stringMatching(why) });
		};
		const noEffect = () => {
			expect(r.sqlite!.prepare("SELECT COUNT(*) AS n FROM auth_tokens").get()).toEqual({ n: 0 });
			expect(r.sqlite!.prepare("SELECT COUNT(*) AS n FROM _emdash_rate_limits").get()).toEqual({
				n: 0,
			});
			expect(r.sessions.get).not.toHaveBeenCalled();
			expect(r.budget.takes).toHaveLength(takes);
			expect(r.budget.reports).toHaveLength(reports);
			expect(r.plugin.sent).toEqual([]);
			expect(r.system.sent).toEqual([]);
		};
		await refusedAll(undefined, /carries no capability/, "none");
		await refusedAll("abc", /carries no capability/, "malformed");
		await refusedAll(
			g2.capability,
			/generation 2's, which is staged, not active/,
			"the staged one",
		);
		await refusedAll(secret(), /not this site's active generation's/, "another");
		// Zero effect of any of them: no database row, no session read, no rate count, no token, no budget call, no send.
		noEffect();
		// G2 activated: G1 is retired, and refused the same way.
		expect(
			(
				await admin(r.b, "activate", {
					generation: 2,
					capabilityHash: await sha256Hex(g2.capability),
					expectActive: 1,
				})
			).status,
		).toBe(200);
		r.budget.activate(2);
		const reportsAfter = r.budget.reports.length;
		await refusedAll(g1.capability, /not this site's active generation's/, "the retired one");
		expect(r.budget.reports).toHaveLength(reportsAfter);
		expect(r.budget.takes).toHaveLength(takes);
		expect(r.sqlite!.prepare("SELECT COUNT(*) AS n FROM _emdash_rate_limits").get()).toEqual({
			n: 0,
		});
		// THE CONTROL: the active one's magic link goes, through EMAIL_SYSTEM with its system token.
		expect(
			await r.b.requestMagicLink({
				protocol: P,
				capability: g2.capability,
				requestId: randomUUID(),
				email: "admin@example.org",
				ip: null,
			}),
		).toMatchObject({ status: "sent" });
		expect(r.system.sent).toHaveLength(1);
		expect(r.budget.takes.at(-1)).toMatchObject({ token: g2.system, protocol: 3 });
		expect(r.plugin.sent).toEqual([]);
	});
});

/** Stage generation `g` in the budget and the broker (not activated): the broker's answer. */
async function stageBoth(r: Rig, g: number, c: Creds, expectActive: number | null) {
	r.budget.stage(g, c);
	return admin(r.b, "stage", {
		generation: g,
		capabilityHash: await sha256Hex(c.capability),
		tokens: { plugin: c.plugin, system: c.system },
		expectActive,
	});
}
const activate = async (r: Rig, g: number, c: Creds, expectActive: number | null) =>
	admin(r.b, "activate", {
		generation: g,
		capabilityHash: await sha256Hex(c.capability),
		expectActive,
	});

/** A promise with whether it has settled yet. */
function watch<T>(p: Promise<T>) {
	const w = { done: false, value: undefined as T | undefined, promise: p };
	void p.then((v) => {
		w.done = true;
		w.value = v;
		return v;
	});
	return w;
}

describe("THE QUEUE", () => {
	it("MUTATION 1: with G0 paused inside the Email binding's send, activate(G1) stays pending; released, G0 is sent and only then does the activation answer; after it every G0 call is refused before the budget or a send", async () => {
		const r = rig();
		const g0 = creds();
		const g1 = creds();
		await bringUp(r, 1, g0, null);
		const hold = r.plugin.pauseSend();
		const inFlight = watch(sendWith(r.b, g0.capability));
		await hold.entered;
		// The operator rotates meanwhile: the budget retires G0's tokens and stages G1's, the broker is asked to stage and activate G1.
		const staged = watch(stageBoth(r, 2, g1, 1));
		await settle();
		const activated = watch(activate(r, 2, g1, 1));
		await settle();
		expect(inFlight.done).toBe(false);
		expect(staged.done).toBe(false);
		expect(activated.done).toBe(false);
		hold.release();
		const sent = await inFlight.promise;
		expect(sent).toMatchObject({ status: "sent" });
		const ack = await activated.promise;
		expect(ack).toMatchObject({ status: 200, body: { active: { generation: 2 } } });
		// The DO-side order: the G0 send entered before the activation, and ended before it answered.
		expect(sent.seq).toBeLessThan(Number(ack.body.seq));
		expect(r.plugin.sent).toHaveLength(1);
		r.budget.activate(2);
		const takes = r.budget.takes.length;
		for (let i = 0; i < 3; i++)
			expect(await sendWith(r.b, g0.capability)).toMatchObject({
				status: "refused",
				why: expect.stringMatching(/not this site's active generation's/),
			});
		expect(
			await r.b.requestMagicLink({
				protocol: P,
				capability: g0.capability,
				requestId: randomUUID(),
				email: "admin@example.org",
				ip: null,
			}),
		).toMatchObject({ status: "refused" });
		expect(r.budget.takes).toHaveLength(takes);
		expect(r.plugin.sent).toHaveLength(1);
		// THE CONTROL: G1 sends.
		expect(await sendWith(r.b, g1.capability)).toMatchObject({ status: "sent" });
	});

	it("MUTATION 2: a G0 call paused before it reaches the queue is ordered after an activation of G1 that reached it first, and is refused", async () => {
		const r = rig();
		const g0 = creds();
		const g1 = creds();
		await bringUp(r, 1, g0, null);
		await stageBoth(r, 2, g1, 1);
		// G0's request is on its way (in the site's old isolate, on the wire): not in the queue yet.
		const gate = deferred();
		const late = gate.promise.then(() => sendWith(r.b, g0.capability));
		expect((await activate(r, 2, g1, 1)).status).toBe(200);
		gate.resolve();
		expect(await late).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not this site's active generation's/),
		});
		// And a G0 call that entered the queue after the activation, while the activation waited behind another call, is refused as well.
		r.budget.activate(2);
		const g2 = creds();
		const hold = r.plugin.pauseSend();
		const busy = sendWith(r.b, g1.capability);
		await hold.entered;
		const staged3 = watch(stageBoth(r, 3, g2, 2));
		await settle();
		const act3 = watch(activate(r, 3, g2, 2));
		await settle();
		const afterIt = watch(sendWith(r.b, g1.capability));
		await settle();
		expect([staged3.done, act3.done, afterIt.done]).toEqual([false, false, false]);
		hold.release();
		expect(await busy).toMatchObject({ status: "sent" });
		expect((await act3.promise).status).toBe(200);
		expect(await afterIt.promise).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not this site's active generation's/),
		});
		expect(Number((await afterIt.promise).seq)).toBeGreaterThan(
			Number((await act3.promise).body.seq),
		);
	});

	it("covers the budget's take as well: G0 paused inside its take holds a retire (the operator's fence) until it is sent", async () => {
		const r = rig();
		const g0 = creds();
		await bringUp(r, 1, g0, null);
		const hold = r.budget.pauseTake();
		const inFlight = watch(sendWith(r.b, g0.capability));
		await hold.entered;
		const retired = watch(admin(r.b, "retire", { generation: 1 }));
		await settle();
		expect([inFlight.done, retired.done]).toEqual([false, false]);
		hold.release();
		expect(await inFlight.promise).toMatchObject({ status: "sent" });
		expect(await retired.promise).toMatchObject({
			status: 200,
			body: { active: null, retired: ["active"] },
		});
		expect(await sendWith(r.b, g0.capability)).toMatchObject({ status: "refused" });
	});

	it("a send that fails after its generation was rotated in the budget is given back by the EXACT retired token", async () => {
		const r = rig();
		const g0 = creds();
		const g1 = creds();
		await bringUp(r, 1, g0, null);
		const hold = r.plugin.pauseSend();
		r.plugin.failNext(Object.assign(new Error("nope"), { code: "E_SEND_FAILED" }));
		const inFlight = sendWith(r.b, g0.capability);
		await hold.entered;
		// The budget retires G0 (G1 staged) while the send is in the binding; then the binding refuses it.
		r.budget.stage(2, g1);
		expect(r.budget.tokens.has(g0.plugin)).toBe(false);
		hold.release();
		expect(await inFlight).toMatchObject({
			status: "refused",
			why: "EMAIL_PLUGIN refused it (E_SEND_FAILED)",
		});
		expect(r.budget.refunds).toEqual([
			{ protocol: 3, token: g0.plugin, takeId: expect.any(String) },
		]);
		expect(r.budget.counted()).toBe(0);
	});

	it("keeps each generation apart on one stable service binding: G0 sends until the budget rotates, nothing sends between the rotation and both activations, then only G1; never both", async () => {
		const r = rig();
		const g0 = creds();
		const g1 = creds();
		await bringUp(r, 1, g0, null);
		const round = async () => {
			const out = [];
			for (let i = 0; i < 6; i++)
				out.push({ gen: i % 2, a: await sendWith(r.b, (i % 2 ? g1 : g0).capability) });
			return out.map((o) => `${o.gen}:${o.a.status}`);
		};
		const sent = (gen: number) => Array(3).fill(`${gen}:sent`);
		const refused = (gen: number) => Array(3).fill(`${gen}:refused`);
		const pairs = (a: string[], b: string[]) => a.flatMap((x, i) => [x, b[i]!]);
		// G0 active: only G0.
		expect(await round()).toEqual(pairs(sent(0), refused(1)));
		// The budget retired G0 and staged G1, and the broker staged G1: nobody.
		await stageBoth(r, 2, g1, 1);
		expect(await round()).toEqual(pairs(refused(0), refused(1)));
		// The broker activated G1 and the budget has not yet: still nobody (G1's take is refused while it is staged there).
		expect((await activate(r, 2, g1, 1)).status).toBe(200);
		expect(await round()).toEqual(pairs(refused(0), refused(1)));
		// Both activated: only G1.
		r.budget.activate(2);
		expect(await round()).toEqual(pairs(refused(0), sent(1)));
		expect(r.plugin.sent).toHaveLength(6);
	});
});

describe("a give-back (CURE 6: inside the fence)", () => {
	it("that the budget does not answer is OWED in the broker's storage; neither an activation nor a retire is acknowledged until every owed give-back is settled, across a restart, and the plugin and system lanes alike", async () => {
		const store = mapStore();
		const budget = fakeBudget();
		const r = rig({ store, budget, auth: true });
		const g0 = creds();
		const g1 = creds();
		await bringUp(r, 1, g0, null);
		// G0's form mail: EMAIL_PLUGIN refuses it, and its give-back never reaches the budget.
		r.plugin.failNext(Object.assign(new Error("refused"), { code: "E_SENDER_NOT_VERIFIED" }));
		budget.failRefunds(1);
		expect(await sendWith(r.b, g0.capability)).toMatchObject({ status: "refused" });
		// G0's magic link: EMAIL_SYSTEM refuses it, and its give-back is lost too.
		r.system.failNext(Object.assign(new Error("refused"), { code: "E_SENDER_NOT_VERIFIED" }));
		budget.failRefunds(1);
		expect(
			await r.b.requestMagicLink({
				protocol: P,
				capability: g0.capability,
				requestId: randomUUID(),
				email: "admin@example.org",
				ip: null,
			}),
		).toMatchObject({ status: "refused" });
		// Both places are still counted, and the broker says it owes both.
		expect(budget.counted()).toBe(2);
		expect((await admin(r.b, "state")).body).toMatchObject({ owedRefunds: 2 });
		// G1 staged; while the budget still does not answer, its activation is NOT acknowledged, and G0 stays active.
		expect((await stageBoth(r, 2, g1, 1)).status).toBe(200);
		budget.failRefunds(2);
		const held = await activate(r, 2, g1, 1);
		expect(held.status).toBe(503);
		expect(held.body).toMatchObject({ ok: false, active: { generation: 1 }, staged: { generation: 2 } });
		expect(held.body.error).toMatch(/give-back\(s\) of places earlier sends took are not yet known to be done/);
		// The object restarts: what it owes is in its storage, and the activation settles it first.
		const after = rig({ store, budget, auth: true });
		const acked = await activate(after, 2, g1, 1);
		expect(acked.status, JSON.stringify(acked.body)).toBe(200);
		expect(acked.body).toMatchObject({ owedRefunds: 0, active: { generation: 2 } });
		expect(budget.counted()).toBe(0);
		// Each by the EXACT token that took it (G0's, retired in the budget by then).
		expect(budget.refunds.filter((x) => x.token === g0.plugin).at(-1)).toMatchObject({
			takeId: expect.any(String),
		});
		expect(budget.refunds.filter((x) => x.token === g0.system).at(-1)).toMatchObject({
			takeId: expect.any(String),
		});
		// A retire likewise: retired at once, acknowledged only once nothing is owed.
		budget.activate(2);
		after.plugin.failNext(Object.assign(new Error("refused"), { code: "E_SENDER_NOT_VERIFIED" }));
		budget.failRefunds(1);
		expect(await sendWith(after.b, g1.capability)).toMatchObject({ status: "refused" });
		budget.failRefunds(1);
		const retiring = await admin(after.b, "retire", { generation: 2 });
		expect(retiring.status).toBe(503);
		expect(retiring.body).toMatchObject({ ok: false, retired: ["active"], active: null, owedRefunds: 1 });
		// Nothing of G1 counts from the retire on, acknowledged or not.
		expect(await sendWith(after.b, g1.capability)).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not this site's active generation's/),
		});
		const retired = await admin(after.b, "retire", { generation: 2 });
		expect(retired.status).toBe(200);
		expect(retired.body).toMatchObject({ ok: true, retired: [], owedRefunds: 0 });
		expect(budget.counted()).toBe(0);
	});

	it("of a take whose answer was lost twice is owed by its request id, and settled by it: the budget gives back whatever that request id took with that token", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		// The take commits, and both answers are lost: whether it counted is not known to the broker.
		r.budget.loseNextAnswer();
		r.budget.loseNextAnswer();
		r.budget.failRefunds(1);
		expect(await sendWith(r.b, c.capability)).toMatchObject({
			status: "refused",
			why: "the mail budget could not be asked",
		});
		expect(r.plugin.sent).toEqual([]);
		expect(r.budget.counted()).toBe(1);
		expect((await admin(r.b, "state")).body).toMatchObject({ owedRefunds: 1 });
		// The next fence asks for it by the request id, and the budget gives that take back.
		const g2 = creds();
		expect((await stageBoth(r, 2, g2, 1)).status).toBe(200);
		expect((await activate(r, 2, g2, 1)).status).toBe(200);
		expect(r.budget.refunds.at(-1)).toEqual({
			protocol: 3,
			token: c.plugin,
			requestId: r.budget.takes[0]!.requestId,
		});
		expect(r.budget.counted()).toBe(0);
	});
});

describe("THE QUEUE's classes (neighbors of CURES 4-6)", () => {
	it("an operator's call overtakes the site's and anonymous calls WAITING (never the one running), so a flood of sign-in requests cannot hold a retire; the calls it overtook run after it, held to what it left; at most ANONYMOUS_WAITING_MAX anonymous calls wait, and one more is refused at once", async () => {
		const r = rig({ auth: true });
		const c = creds();
		await bringUp(r, 1, c, null);
		const link = () => ({
			protocol: P,
			capability: c.capability,
			requestId: randomUUID(),
			email: "admin@example.org",
			ip: null,
		});
		const hold = r.system.pauseSend();
		const running = watch(r.b.requestMagicLink(link()));
		await hold.entered;
		const flood = Array.from({ length: ANONYMOUS_WAITING_MAX }, () =>
			watch(r.b.requestMagicLink(link())),
		);
		const form = watch(sendWith(r.b, c.capability));
		const takes = r.budget.takes.length;
		// One more anonymous request than may wait: refused at once, nothing read, counted or sent for it.
		expect(await r.b.requestMagicLink(link())).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/as many sign-in requests waiting as it takes/),
		});
		const retire = watch(admin(r.b, "retire", { generation: 1 }));
		await settle();
		// The retire waits for the call running, and for nothing else.
		expect(retire.done).toBe(false);
		hold.release();
		const retired = await retire.promise;
		expect(retired.status).toBe(200);
		const at = retired.body.seq as number;
		const first = await running.promise;
		expect(first).toMatchObject({ status: "sent" });
		expect(first.seq).toBeLessThan(at);
		for (const w of [form, ...flood]) {
			const a = await w.promise;
			expect(a).toMatchObject({
				status: "refused",
				why: expect.stringMatching(/not this site's active generation's/),
			});
			expect(a.seq).toBeGreaterThan(at);
		}
		expect(r.system.sent).toHaveLength(1);
		expect(r.plugin.sent).toEqual([]);
		expect(r.budget.takes).toHaveLength(takes);
	});

	it("a take the budget answers as given back already (a replayed take it refunded) is no place to send in: refused, nothing sent, nothing given back again", async () => {
		const r = rig();
		const c = creds();
		await bringUp(r, 1, c, null);
		r.budget.service.take.mockImplementationOnce((async () => ({
			ok: true,
			protocol: 3,
			takeId: "2026-01-01:00000000-0000-4000-8000-000000000000",
			lane: "plugin",
			generation: 1,
			replayed: true,
			refunded: true,
		})) as never);
		expect(await sendWith(r.b, c.capability)).toMatchObject({
			status: "refused",
			why: "the mail budget refused it (refunded)",
		});
		// As the account's ledger answers such a replay: refused, scope refunded.
		r.budget.service.take.mockImplementationOnce((async () => ({
			ok: false,
			protocol: 3,
			scope: "refunded",
			refused: "that take was given back",
		})) as never);
		expect(await sendWith(r.b, c.capability)).toMatchObject({
			status: "refused",
			why: "the mail budget refused it (refunded)",
		});
		expect(r.plugin.sent).toEqual([]);
		expect(r.budget.refunds).toEqual([]);
	});
});

describe("the active generation", () => {
	it("survives the object's restart and an upload of the broker: a new object over the same storage answers the same generation, and its numbering goes on", async () => {
		const store = mapStore();
		const budget = fakeBudget();
		const before = rig({ store, budget });
		const g0 = creds();
		const g1 = creds();
		await bringUp(before, 1, g0, null);
		await bringUp(before, 2, g1, 1);
		const last = (await sendWith(before.b, g1.capability)).seq;
		const after = rig({ store, budget });
		const state = await admin(after.b, "state");
		expect(state.body).toMatchObject({
			active: { generation: 2, capabilityHash: await sha256Hex(g1.capability) },
			staged: null,
			highest: 2,
		});
		expect(Number(state.body.seq)).toBeGreaterThan(last);
		expect(await sendWith(after.b, g1.capability)).toMatchObject({ status: "sent" });
		expect(await sendWith(after.b, g0.capability)).toMatchObject({ status: "refused" });
	});

	it("staged, sends nothing: a staged generation's capability is refused before its take", async () => {
		const r = rig();
		const g1 = creds();
		expect((await stageBoth(r, 1, g1, null)).status).toBe(200);
		expect(await sendWith(r.b, g1.capability)).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/staged, not active/),
		});
		expect(r.budget.takes).toEqual([]);
	});
});

describe("the admin door", () => {
	it("answers nobody without the operator's secret, and the state it answers carries hashes, never a token", async () => {
		const r = rig();
		const g = creds();
		await bringUp(r, 1, g, null);
		expect((await admin(r.b, "state", undefined, "")).status).toBe(401);
		expect((await admin(r.b, "state", undefined, `Bearer ${secret()}`)).status).toBe(401);
		expect((await admin(rig({ adminSecret: null }).b, "state")).status).toBe(503);
		expect((await admin(rig({ adminSecret: "short" }).b, "state")).status).toBe(503);
		const state = await admin(r.b, "state");
		expect(state.status).toBe(200);
		expect(state.body.active).toEqual({
			generation: 1,
			capabilityHash: await sha256Hex(g.capability),
			tokenHashes: { plugin: await sha256Hex(g.plugin), system: await sha256Hex(g.system) },
			at: expect.any(String),
		});
		const text = JSON.stringify(state.body);
		for (const v of [g.capability, g.plugin, g.system]) expect(text).not.toContain(v);
		expect(
			(await r.b.admin(new Request("https://broker.example/send", { method: "POST" }))).status,
		).toBe(404);
		expect((await admin(r.b, "nope", {})).status).toBe(404);
	});

	it("stages as compare-and-set and once per number, only tokens the budget holds as THIS site's staged lanes of that generation, and activates as compare-and-set", async () => {
		const r = rig();
		const g1 = creds();
		const g2 = creds();
		await bringUp(r, 1, g1, null);
		const body = async (c: Creds, over: Record<string, unknown> = {}) => ({
			generation: 2,
			capabilityHash: await sha256Hex(c.capability),
			tokens: { plugin: c.plugin, system: c.system },
			expectActive: 1,
			...over,
		});
		r.budget.stage(2, g2);
		expect((await admin(r.b, "stage", await body(g2, { expectActive: null }))).status).toBe(409);
		expect((await admin(r.b, "stage", await body(g2, { generation: 1 }))).status).toBe(409);
		// Tokens the budget holds for another site, in the other lane, for another generation, or active: refused, nothing staged.
		const other = creds();
		r.budget.stage(2, other, "other-site");
		expect(await admin(r.b, "stage", await body(other))).toMatchObject({
			status: 400,
			body: { error: expect.stringMatching(/for "other-site", not this broker's site/) },
		});
		expect(
			await admin(
				r.b,
				"stage",
				await body(g2, { tokens: { plugin: g2.system, system: g2.plugin } }),
			),
		).toMatchObject({
			status: 400,
			body: { error: expect.stringMatching(/in the "system" lane/) },
		});
		expect(await admin(r.b, "stage", await body(g2, { generation: 3 }))).toMatchObject({
			status: 400,
			body: { error: expect.stringMatching(/generation 2, not 3/) },
		});
		r.budget.activate(2);
		expect(await admin(r.b, "stage", await body(g2))).toMatchObject({
			status: 400,
			body: { error: expect.stringMatching(/"active", not staged/) },
		});
		for (const bad of [
			{ tokens: { plugin: "raw", system: g2.system } },
			{ tokens: { plugin: g2.plugin, system: g2.plugin } },
			{ capabilityHash: "nothex" },
			{ generation: 0 },
			{ generation: "2" },
			{ expectActive: "1" },
		]) {
			expect((await admin(r.b, "stage", await body(g2, bad))).status, JSON.stringify(bad)).toBe(
				400,
			);
		}
		expect((await admin(r.b, "state")).body).toMatchObject({
			active: { generation: 1 },
			staged: null,
			highest: 1,
		});
		// THE CONTROL.
		r.budget.stage(2, g2);
		expect((await admin(r.b, "stage", await body(g2))).status).toBe(200);
		expect((await activate(r, 2, g2, null)).status).toBe(409);
		expect(
			(
				await admin(r.b, "activate", {
					generation: 2,
					capabilityHash: await sha256Hex(secret()),
					expectActive: 1,
				})
			).status,
		).toBe(409);
		expect((await activate(r, 3, g2, 1)).status).toBe(409);
		expect((await activate(r, 2, g2, 1)).body).toMatchObject({
			active: { generation: 2 },
			unchanged: false,
		});
		expect((await activate(r, 2, g2, 1)).body).toMatchObject({
			active: { generation: 2 },
			unchanged: true,
		});
		// A retired generation is gone and its number stays used.
		expect((await admin(r.b, "retire", { generation: 2 })).body).toMatchObject({
			active: null,
			retired: ["active"],
			highest: 2,
		});
		r.budget.stage(2, g2);
		expect((await admin(r.b, "stage", await body(g2, { expectActive: null }))).status).toBe(409);
	});
});

describe("the status", () => {
	it("tells an unknown capability only the numbers and asks the budget nothing; the staged or active one's gets its hashes and the budget's report of each lane; nothing is sent, counted or disclosed", async () => {
		const r = rig();
		const g1 = creds();
		const g2 = creds();
		await bringUp(r, 1, g1, null);
		await stageBoth(r, 2, g2, 1);
		const reports = r.budget.reports.length;
		const unknown = await r.b.status({ protocol: P, capability: secret() });
		expect(unknown).toEqual({
			protocol: P,
			marker: AUTH_MAIL_MARKER,
			seq: expect.any(Number),
			tenant: "acme",
			deployment: "artifact-1:code-1",
			send: { plugin: true, system: true },
			site: true,
			recipients: ALLOWED.length,
			generations: { active: 1, staged: 2 },
			capability: "unknown",
		});
		expect(r.budget.reports).toHaveLength(reports);
		const staged = await r.b.status({ protocol: P, capability: g2.capability });
		expect(staged).toMatchObject({
			capability: "staged",
			generation: 2,
			capabilityHash: await sha256Hex(g2.capability),
			tokenHashes: { plugin: await sha256Hex(g2.plugin), system: await sha256Hex(g2.system) },
			budget: {
				plugin: { ok: true, tenant: "acme", lane: "plugin", generation: 2, state: "staged" },
				system: { ok: true, lane: "system", state: "staged" },
			},
		});
		const text = JSON.stringify(staged);
		for (const v of [g2.capability, g2.plugin, g2.system]) expect(text).not.toContain(v);
		expect(r.budget.takes).toEqual([]);
		expect(r.plugin.sent).toEqual([]);
		expect(r.system.sent).toEqual([]);
		expect(await r.b.status({ protocol: 1 })).toMatchObject({ status: "refused" });
	});
});

describe("the broker's configuration", () => {
	it("comes from its Worker's env, and without what a send needs it sends nothing and says what is missing", async () => {
		const budget = fakeBudget();
		const plugin = sendBinding();
		const env = {
			BROKER_TENANT: "acme",
			BROKER_DEPLOYMENT: "a:b",
			BROKER_RECIPIENTS: JSON.stringify(ALLOWED),
			BROKER_ADMIN_SECRET: ADMIN,
			AUTH_MAIL_SITE_URL: SITE.url,
			AUTH_MAIL_SITE_NAME: SITE.name,
			AUTH_MAIL_FROM: SITE.from,
			EMAIL_PLUGIN: plugin.binding,
			EMAIL_SYSTEM: sendBinding().binding,
			MAIL_BUDGET: budget.service,
		};
		const full = brokerConfigFromEnv(env);
		expect(full).toMatchObject({
			tenant: "acme",
			deployment: "a:b",
			site: SITE,
			adminSecret: ADMIN,
		});
		expect([...(full.recipients as Set<string>)]).toEqual(ALLOWED);
		for (const [what, over, why] of [
			["no recipients", { BROKER_RECIPIENTS: "[]" }, /BROKER_RECIPIENTS/],
			[
				"recipients that are not addresses",
				{ BROKER_RECIPIENTS: JSON.stringify(["a@b.example, c@d.example"]) },
				/BROKER_RECIPIENTS/,
			],
			["no EMAIL_PLUGIN", { EMAIL_PLUGIN: undefined }, /no EMAIL_PLUGIN binding/],
			["an http origin", { AUTH_MAIL_SITE_URL: "http://acme.example.org" }, /AUTH_MAIL_SITE_URL/],
		] as const) {
			const store = mapStore();
			const c = creds();
			const b = createMailBroker({
				store,
				config: brokerConfigFromEnv({ ...env, ...over }),
				db: null,
				sessions: null,
			});
			budget.stage(1, c);
			await b.admin(
				new Request("https://broker.example/admin/stage", {
					method: "POST",
					headers: { authorization: `Bearer ${ADMIN}` },
					body: JSON.stringify({
						generation: 1,
						capabilityHash: await sha256Hex(c.capability),
						tokens: { plugin: c.plugin, system: c.system },
						expectActive: null,
					}),
				}),
			);
			await b.admin(
				new Request("https://broker.example/admin/activate", {
					method: "POST",
					headers: { authorization: `Bearer ${ADMIN}` },
					body: JSON.stringify({
						generation: 1,
						capabilityHash: await sha256Hex(c.capability),
						expectActive: null,
					}),
				}),
			);
			budget.activate(1);
			expect(await sendWith(b, c.capability), what).toMatchObject({
				status: "refused",
				why: expect.stringMatching(why),
			});
		}
		expect(plugin.sent).toEqual([]);
	});

	it("is the sign-in mail's too: a broker uploaded without MAIL_BUDGET, EMAIL_SYSTEM, DB, or the site's https URL, name and sender sends no sign-in mail and says what is missing, before any row, count, take or send", async () => {
		const budget = fakeBudget();
		const system = sendBinding();
		const env = {
			BROKER_TENANT: "acme",
			BROKER_DEPLOYMENT: "a:b",
			BROKER_RECIPIENTS: JSON.stringify(ALLOWED),
			BROKER_ADMIN_SECRET: ADMIN,
			AUTH_MAIL_SITE_URL: SITE.url,
			AUTH_MAIL_SITE_NAME: SITE.name,
			AUTH_MAIL_FROM: SITE.from,
			EMAIL_PLUGIN: sendBinding().binding,
			EMAIL_SYSTEM: system.binding,
			MAIL_BUDGET: budget.service,
		};
		const store = mapStore();
		const { sqlite, db } = authDb();
		const counts = () => ({
			tokens: sqlite.prepare("SELECT COUNT(*) AS n FROM auth_tokens").get(),
			rates: sqlite.prepare("SELECT COUNT(*) AS n FROM _emdash_rate_limits").get(),
		});
		// One broker's storage, uploaded again with one thing missing at a time.
		const upload = (over: Record<string, unknown>, withDb: Kysely<AuthMailTables> | null = db) =>
			createMailBroker({
				store,
				config: brokerConfigFromEnv({ ...env, ...over }),
				db: withDb,
				sessions: null,
			});
		const c = creds();
		const full = upload({});
		budget.stage(1, c);
		expect(
			(
				await admin(full, "stage", {
					generation: 1,
					capabilityHash: await sha256Hex(c.capability),
					tokens: { plugin: c.plugin, system: c.system },
					expectActive: null,
				})
			).status,
		).toBe(200);
		expect(
			(
				await admin(full, "activate", {
					generation: 1,
					capabilityHash: await sha256Hex(c.capability),
					expectActive: null,
				})
			).status,
		).toBe(200);
		budget.activate(1);
		const request = {
			protocol: P,
			capability: c.capability,
			email: "admin@example.org",
			ip: "203.0.113.1",
		};
		const takes = budget.takes.length;
		for (const { what, over, why, withDb = db } of [
			{
				what: "no MAIL_BUDGET",
				over: { MAIL_BUDGET: undefined },
				why: /no service binding MAIL_BUDGET/,
			},
			{
				what: "no EMAIL_SYSTEM",
				over: { EMAIL_SYSTEM: undefined },
				why: /the broker has no EMAIL_SYSTEM binding/,
			},
			{
				what: "an http origin",
				over: { AUTH_MAIL_SITE_URL: "http://acme.example.org" },
				why: /AUTH_MAIL_SITE_URL/,
			},
			{ what: "no site name", over: { AUTH_MAIL_SITE_NAME: " " }, why: /AUTH_MAIL_SITE_NAME/ },
			{ what: "no sender", over: { AUTH_MAIL_FROM: "not an address" }, why: /AUTH_MAIL_FROM/ },
			{ what: "no DB", over: {}, why: /the broker has no DB binding/, withDb: null },
		]) {
			// A fresh request id each time: an id this capability used answers what it came to.
			expect(
				await upload(over, withDb).requestMagicLink({ ...request, requestId: randomUUID() }),
				what,
			).toMatchObject({
				status: "refused",
				why: expect.stringMatching(why),
			});
			expect(counts(), what).toEqual({ tokens: { n: 0 }, rates: { n: 0 } });
		}
		expect(budget.takes).toHaveLength(takes);
		expect(system.sent).toEqual([]);
		// THE CONTROL: the same storage and request, uploaded with everything, sends it.
		expect(
			await upload({}).requestMagicLink({ ...request, requestId: randomUUID() }),
		).toMatchObject({ status: "sent" });
		expect(system.sent).toHaveLength(1);
		expect(budget.takes.at(-1)).toMatchObject({ token: c.system, protocol: 3 });
		await db.destroy();
	});
});
