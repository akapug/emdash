/**
 * The auth-mail mediator (src/auth-mail/mediator.ts): EmDash's own sign-in
 * mail, issued and sent by a Worker of its own (the site's mail broker, which
 * runs these operations in its queue: tests/mail-broker.test.ts). Over a real
 * SQLite database with EmDash's auth tables and @emdash-cms/auth's own token
 * and template code; the mail budget and EMAIL_SYSTEM stood in by doubles that
 * keep every call.
 */

import { hashPrefixedToken, hashToken } from "@emdash-cms/auth";
import { AUTH_TABLES_SQL } from "@emdash-cms/auth/adapters/kysely";
import Database from "better-sqlite3";
import { stringify } from "devalue";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
	class Base {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	return { WorkerEntrypoint: Base, DurableObject: Base };
});

import {
	AUTH_MAIL_PROTOCOL,
	createAuthMailMediator,
	parseRequest,
	type AuthMailDeps,
	type AuthMailTables,
} from "../src/auth-mail/mediator.js";
import MailBrokerEntrypoint from "../src/auth-mail/worker.js";
import { createBudgetClient, type BrokerStore } from "../src/auth-mail/broker.js";

const SITE = {
	url: "https://acme.example.org",
	name: "Acme",
	from: "notifications@mail.example.net",
};
const ADMIN_PAT = "ec_pat_adminadminadminadminadminadmin01";
const EDITOR_PAT = "ec_pat_editoreditoreditoreditoreditor01";
const SCOPED_PAT = "ec_pat_contentcontentcontentcontent0001";
const EXPIRED_PAT = "ec_pat_expiredexpiredexpiredexpired0001";
const ADMIN_OAT = "ec_oat_oauthoauthoauthoauthoauthoauth001";
const SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const EDITOR_SESSION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

let sqlite: Database.Database;
let db: Kysely<AuthMailTables>;

async function setup() {
	sqlite = new Database(":memory:");
	for (const statement of AUTH_TABLES_SQL.split(";")
		.map((s) => s.trim())
		.filter(Boolean)) {
		sqlite.exec(statement);
	}
	sqlite.exec(
		`CREATE TABLE _emdash_api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, created_at TEXT)`,
	);
	sqlite.exec(
		`CREATE TABLE _emdash_oauth_tokens (token_hash TEXT PRIMARY KEY, token_type TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL, client_type TEXT NOT NULL DEFAULT 'cli', expires_at TEXT NOT NULL, refresh_token_hash TEXT, created_at TEXT)`,
	);
	sqlite.exec(
		`CREATE TABLE _emdash_rate_limits (key TEXT NOT NULL, "window" TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (key, "window"))`,
	);
	const now = new Date().toISOString();
	const user = sqlite.prepare(
		"INSERT INTO users (id, email, name, role, email_verified, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
	);
	user.run("u-admin", "admin@example.org", "Admin", 50, 0, now, now);
	user.run("u-editor", "editor@example.org", "Editor", 40, 0, now, now);
	user.run("u-gone", "gone@example.org", "Gone", 30, 1, now, now);
	const pat = sqlite.prepare(
		"INSERT INTO _emdash_api_tokens (id, name, token_hash, prefix, user_id, scopes, expires_at) VALUES (?, 'op', ?, 'ec_pat_', ?, ?, ?)",
	);
	pat.run("t1", hashPrefixedToken(ADMIN_PAT), "u-admin", JSON.stringify(["admin"]), null);
	pat.run("t2", hashPrefixedToken(EDITOR_PAT), "u-editor", JSON.stringify(["admin"]), null);
	pat.run("t3", hashPrefixedToken(SCOPED_PAT), "u-admin", JSON.stringify(["content:read"]), null);
	pat.run(
		"t4",
		hashPrefixedToken(EXPIRED_PAT),
		"u-admin",
		JSON.stringify(["admin"]),
		"2020-01-01T00:00:00.000Z",
	);
	sqlite
		.prepare(
			"INSERT INTO _emdash_oauth_tokens (token_hash, token_type, user_id, scopes, expires_at) VALUES (?, 'access', 'u-admin', ?, ?)",
		)
		.run(hashPrefixedToken(ADMIN_OAT), JSON.stringify(["admin"]), "2999-01-01T00:00:00.000Z");
	sqlite
		.prepare(
			"INSERT INTO allowed_domains (domain, default_role, enabled, created_at) VALUES (?, 20, 1, ?)",
		)
		.run("partners.example.org", now);
	db = new Kysely<AuthMailTables>({ dialect: new SqliteDialect({ database: sqlite }) });
}

/** The session store as Astro writes it: devalue over a Map of { data, expires }. */
function sessionStore() {
	const map = new Map<string, string>([
		[SESSION_ID, stringify(new Map([["user", { data: { id: "u-admin" } }]]))],
		[EDITOR_SESSION, stringify(new Map([["user", { data: { id: "u-editor" } }]]))],
	]);
	return { map, get: vi.fn(async (key: string) => map.get(key) ?? null) };
}

/** The mail budget's system lane: every take and refund kept; `answer` decides what a take gets. */
function systemBudget(
	answer: () => unknown = () => ({ ok: true, protocol: 3, lane: "system", generation: 1 }),
) {
	const takes: Array<Record<string, unknown>> = [];
	const refunds: Array<Record<string, unknown>> = [];
	let n = 0;
	const service = {
		take: vi.fn(async (req: Record<string, unknown>) => {
			takes.push(req);
			const a = answer();
			return a && typeof a === "object" && (a as { ok?: unknown }).ok === true
				? { takeId: `2026-01-01:take-${++n}`, ...(a as object) }
				: a;
		}),
		refund: vi.fn(async (req: Record<string, unknown>) => {
			refunds.push(req);
			return { ok: true, protocol: 3, refunded: 1 };
		}),
		report: vi.fn(async () => ({ ok: true, protocol: 3, tenant: "acme", lane: "system" })),
	};
	return { service, takes, refunds };
}

/** A store over a Map, as the broker's Durable Object storage. */
function mapStore(map = new Map<string, unknown>()): BrokerStore {
	return {
		get: (key) => map.get(key),
		put: (key, value) => void map.set(key, value),
		delete: (key) => void map.delete(key),
		keys: (prefix, limit) =>
			[...map.keys()]
				.filter((k) => k.startsWith(prefix))
				.toSorted()
				.slice(0, limit),
	};
}

/** Generation 1's system lane over `service`, as the broker hands it to the mediator (its own take and give-back). */
const systemLane = (service: ReturnType<typeof systemBudget>["service"]) =>
	createBudgetClient({ store: mapStore(), budget: service }).lane("sys-token", {
		lane: "system",
		generation: 1,
	});

/** EMAIL_SYSTEM: every message kept; `fail` makes it refuse. */
function systemSend(fail?: Error) {
	const sent: Array<Record<string, unknown>> = [];
	return {
		sent,
		binding: {
			send: vi.fn(async (message: Record<string, unknown>) => {
				if (fail) throw fail;
				sent.push(message);
				return { messageId: "m-1" };
			}),
		},
	};
}

function mediator(over: Partial<AuthMailDeps> = {}) {
	const budget = systemBudget();
	const mail = systemSend();
	const sessions = sessionStore();
	const deps: AuthMailDeps = {
		db,
		sessions,
		budget: systemLane(budget.service),
		send: mail.binding,
		site: SITE,
		...over,
	};
	return { m: createAuthMailMediator(deps), budget, mail, sessions };
}

const tokens = () =>
	sqlite.prepare("SELECT hash, type, email, invited_by FROM auth_tokens").all() as Array<{
		hash: string;
		type: string;
		email: string | null;
		invited_by: string | null;
	}>;
const linkIn = (text: string) => /https:\/\/\S+token=[A-Za-z0-9_-]+/.exec(text)?.[0] ?? null;
const tokenIn = (link: string) => new URL(link).searchParams.get("token") ?? "";

const P = AUTH_MAIL_PROTOCOL;

beforeEach(async () => {
	await setup();
});
afterEach(async () => {
	await db.destroy();
});

describe("a request", () => {
	it("is exactly its operation's fields: a subject, a body, a link, a token, a template or a recipient list is refused, and nothing is sent", async () => {
		const extras = {
			subject: "x",
			text: "x",
			html: "<p>",
			link: "https://evil.example/",
			token: "t",
			to: "a@example.org",
			cc: ["b@example.org"],
			recipients: ["c@example.org"],
			template: "x",
			system: true,
			from: "x@example.org",
		};
		const { m, budget, mail } = mediator();
		const base = {
			requestMagicLink: { protocol: P, email: "admin@example.org", ip: null },
			requestSignup: { protocol: P, email: "new@partners.example.org", ip: null },
			createInvite: {
				protocol: P,
				email: "new@example.org",
				role: 30,
				authorization: `Bearer ${ADMIN_PAT}`,
				cookie: null,
			},
			sendRecovery: {
				protocol: P,
				userId: "u-editor",
				authorization: `Bearer ${ADMIN_PAT}`,
				cookie: null,
			},
		} as const;
		for (const [op, request] of Object.entries(base)) {
			for (const [key, value] of Object.entries(extras)) {
				const a = await m[op as keyof typeof base]({ ...request, [key]: value });
				expect(a, `${op} + ${key}`).toMatchObject({
					protocol: P,
					status: "refused",
					why: expect.stringContaining(`takes no "${key}"`),
				});
			}
			// Another protocol, and none.
			for (const protocol of [1, "2", undefined]) {
				expect(await m[op as keyof typeof base]({ ...request, protocol })).toMatchObject({
					status: "refused",
				});
			}
		}
		expect(mail.sent).toEqual([]);
		expect(budget.takes).toEqual([]);
		expect(tokens()).toEqual([]);
		// Each field of its kind.
		expect(
			parseRequest("requestMagicLink", {
				protocol: P,
				email: "a@b.example, c@d.example",
				ip: null,
			}),
		).toMatchObject({ refused: expect.stringMatching(/not one plain address/) });
		expect(
			parseRequest("requestMagicLink", {
				protocol: P,
				email: "admin@example.org",
				ip: "not an ip",
			}),
		).toMatchObject({ refused: expect.stringMatching(/not a valid ip/) });
		expect(
			parseRequest("createInvite", {
				protocol: P,
				email: "n@example.org",
				role: 99,
				authorization: null,
				cookie: null,
			}),
		).toMatchObject({ refused: expect.stringMatching(/role/) });
		expect(parseRequest("requestMagicLink", "email")).toMatchObject({
			refused: "the request is not an object",
		});
	});
});

describe("a magic link", () => {
	it("is generated and sent by the mediator itself, with its own token and EmDash's own template, taking the system lane's place", async () => {
		const { m, budget, mail } = mediator();
		const a = await m.requestMagicLink({
			protocol: P,
			email: "admin@example.org",
			ip: "203.0.113.7",
		});
		expect(a).toEqual({ protocol: P, status: "sent" });
		// The answer carries no token, link or address.
		expect(JSON.stringify(a)).not.toMatch(/token|https:|@/);
		expect(mail.sent).toHaveLength(1);
		const [message] = mail.sent as Array<{
			to: string;
			from: unknown;
			subject: string;
			text: string;
			html?: string;
		}>;
		expect(message).toMatchObject({
			to: "admin@example.org",
			from: { email: SITE.from, name: "Acme" },
			subject: "Sign in to Acme",
		});
		// The link is to the operator's origin, with a token whose hash the mediator stored.
		const link = linkIn(message!.text)!;
		expect(link.startsWith(`${SITE.url}/_emdash/api/auth/magic-link/verify?token=`)).toBe(true);
		expect(tokens()).toEqual([
			{
				hash: hashToken(tokenIn(link)),
				type: "magic_link",
				email: "admin@example.org",
				invited_by: null,
			},
		]);
		// Its place in the budget: the system token, the recipient's hash and a request id, nothing else.
		expect(budget.takes).toHaveLength(1);
		expect(Object.keys(budget.takes[0]!).toSorted()).toEqual([
			"protocol",
			"recipients",
			"requestId",
			"token",
		]);
		expect(budget.takes[0]).toMatchObject({ protocol: 3, token: "sys-token" });
		expect(JSON.stringify(budget.takes)).not.toContain("@");
	});

	it("goes to nobody who is not an enabled user, and says only that it skipped", async () => {
		const { m, mail, budget } = mediator();
		for (const email of ["nobody@example.org", "gone@example.org"]) {
			expect(await m.requestMagicLink({ protocol: P, email, ip: null })).toMatchObject({
				status: "skipped",
			});
		}
		expect(mail.sent).toEqual([]);
		expect(budget.takes).toEqual([]);
		expect(tokens()).toEqual([]);
	});

	it("is rate limited by recipient whatever IP the tenant names, and by IP", async () => {
		const { m, mail } = mediator();
		for (let i = 0; i < 3; i++) {
			expect(
				await m.requestMagicLink({ protocol: P, email: "admin@example.org", ip: `203.0.113.${i}` }),
			).toMatchObject({ status: "sent" });
		}
		// A fourth from a fresh IP, and one with no IP at all: the recipient's own limit holds.
		expect(
			await m.requestMagicLink({ protocol: P, email: "admin@example.org", ip: "198.51.100.9" }),
		).toMatchObject({ status: "skipped", why: "rate limited" });
		expect(
			await m.requestMagicLink({ protocol: P, email: "admin@example.org", ip: null }),
		).toMatchObject({ status: "skipped", why: "rate limited" });
		expect(mail.sent).toHaveLength(3);
		// One IP asking for three people, then a fourth (on a fresh day's counts).
		await setup();
		const other = mediator();
		for (const email of ["editor@example.org", "nobody1@example.org", "nobody2@example.org"]) {
			await other.m.requestMagicLink({ protocol: P, email, ip: "192.0.2.1" });
		}
		expect(
			await other.m.requestMagicLink({ protocol: P, email: "admin@example.org", ip: "192.0.2.1" }),
		).toMatchObject({ status: "skipped", why: "rate limited" });
	});
});

describe("a send that does not go out", () => {
	it("gives its place back and deletes the token it issued, when EMAIL_SYSTEM refuses it", async () => {
		const failing = systemSend(
			Object.assign(new Error("recipient refused admin@example.org"), {
				code: "E_RECIPIENT_NOT_ALLOWED",
			}),
		);
		const { m, budget } = mediator({ send: failing.binding });
		const a = await m.requestMagicLink({ protocol: P, email: "admin@example.org", ip: null });
		expect(a).toEqual({
			protocol: P,
			status: "refused",
			why: "EMAIL_SYSTEM refused it (E_RECIPIENT_NOT_ALLOWED)",
		});
		expect(JSON.stringify(a)).not.toContain("admin@");
		expect(budget.refunds).toEqual([
			{ protocol: 3, token: "sys-token", takeId: "2026-01-01:take-1" },
		]);
		expect(tokens()).toEqual([]);
	});

	it("sends nothing and deletes the token when the budget refuses, answers in another protocol, or counts it to another lane than the system lane of its generation (the broker's own take, which the mediator takes through)", async () => {
		for (const [what, answerIs, why, refunded] of [
			[
				"refused",
				() => ({ ok: false, protocol: 3, scope: "account", refused: "full" }),
				/the mail budget refused it \(account\)/,
				0,
			],
			["another protocol", () => ({ ok: true, protocol: 1 }), /answered in another protocol/, 1],
			[
				"the plugin lane",
				() => ({ ok: true, protocol: 3, lane: "plugin", generation: 1 }),
				/not the system lane of 1/,
				1,
			],
			[
				"another generation",
				() => ({ ok: true, protocol: 3, lane: "system", generation: 7 }),
				/generation 7, not the system lane of 1/,
				1,
			],
		] as const) {
			// A fresh database each time: a recipient gets three a window.
			await setup();
			const budget = systemBudget(answerIs);
			const mail = systemSend();
			const { m } = mediator({
				budget: systemLane(budget.service),
				send: mail.binding,
			});
			const a = await m.requestMagicLink({ protocol: P, email: "admin@example.org", ip: null });
			expect(a, what).toMatchObject({ status: "refused", why: expect.stringMatching(why) });
			expect(mail.sent, what).toEqual([]);
			expect(budget.refunds, what).toHaveLength(refunded);
			expect(tokens(), what).toEqual([]);
		}
	});
});

describe("a sign-up", () => {
	it("is verified by mail only for an allowed domain and an address that is no user yet", async () => {
		const { m, mail } = mediator();
		expect(
			await m.requestSignup({ protocol: P, email: "new@partners.example.org", ip: null }),
		).toEqual({ protocol: P, status: "sent" });
		expect(
			linkIn((mail.sent[0] as { text: string }).text)!.startsWith(
				`${SITE.url}/_emdash/admin/signup?token=`,
			),
		).toBe(true);
		expect(tokens().map((t) => t.type)).toEqual(["email_verify"]);
		for (const email of ["new@elsewhere.example.org", "admin@example.org"]) {
			expect(await m.requestSignup({ protocol: P, email, ip: null })).toMatchObject({
				status: "skipped",
			});
		}
		expect(mail.sent).toHaveLength(1);
	});
});

describe("an invite", () => {
	const invite = (
		credential: { authorization?: string | null; cookie?: string | null },
		over: Record<string, unknown> = {},
	) => ({
		protocol: P,
		email: "newhire@example.org",
		role: 30,
		authorization: null,
		cookie: null,
		...credential,
		...over,
	});

	it("is the admin's alone, authenticated by the mediator from the original credential: a token with the admin scope, or the admin's session", async () => {
		for (const credential of [
			{ authorization: `Bearer ${ADMIN_PAT}` },
			{ authorization: `Bearer ${ADMIN_OAT}` },
			{ cookie: `theme=dark; astro-session=${SESSION_ID}` },
		]) {
			await setup();
			const { m, mail } = mediator();
			expect(await m.createInvite(invite(credential)), JSON.stringify(credential)).toEqual({
				protocol: P,
				status: "sent",
			});
			const [row] = tokens();
			expect(row).toMatchObject({
				type: "invite",
				email: "newhire@example.org",
				invited_by: "u-admin",
			});
			const link = linkIn((mail.sent[0] as { text: string }).text)!;
			expect(link.startsWith(`${SITE.url}/_emdash/admin/invite/accept?token=`)).toBe(true);
			expect(row!.hash).toBe(hashToken(tokenIn(link)));
		}
	});

	it("sends nothing for no credential, an unknown, expired, unscoped or non-admin one, a forged session, an invitee who is a user, or a role above the inviter's", async () => {
		const { m, mail, budget } = mediator();
		for (const [what, request, why] of [
			["no credential", invite({}), /carries no credential/],
			[
				"a token nobody holds",
				invite({ authorization: "Bearer ec_pat_nobodynobodynobodynobodynobody01" }),
				/not one the site knows/,
			],
			[
				"not a bearer token",
				invite({ authorization: "Basic YWRtaW46YWRtaW4=" }),
				/not a token the mediator takes/,
			],
			["an expired token", invite({ authorization: `Bearer ${EXPIRED_PAT}` }), /expired/],
			[
				"a token without the admin scope",
				invite({ authorization: `Bearer ${SCOPED_PAT}` }),
				/admin scope/,
			],
			["a non-admin's token", invite({ authorization: `Bearer ${EDITOR_PAT}` }), /not an admin/],
			[
				"a session nobody holds",
				invite({ cookie: "astro-session=11111111-2222-4333-8444-555555555555" }),
				/not one the site knows/,
			],
			[
				"a non-admin's session",
				invite({ cookie: `astro-session=${EDITOR_SESSION}` }),
				/not an admin/,
			],
			["a cookie with no session", invite({ cookie: "theme=dark" }), /carries no session/],
			[
				"an invitee who is a user",
				invite({ authorization: `Bearer ${ADMIN_PAT}` }, { email: "editor@example.org" }),
				/user_exists/,
			],
		] as const) {
			expect(await m.createInvite(request), what).toMatchObject({
				status: "refused",
				why: expect.stringMatching(why),
			});
		}
		expect(mail.sent).toEqual([]);
		expect(budget.takes).toEqual([]);
		expect(tokens()).toEqual([]);
	});

	it("never takes the tenant's word for the inviter: a tenant-made assertion is a field the operation does not take", async () => {
		const { m, mail } = mediator();
		for (const assertion of [
			{ invitedBy: "u-admin" },
			{ user: { id: "u-admin", role: 50 } },
			{ approved: true },
		]) {
			expect(await m.createInvite({ ...invite({}), ...assertion })).toMatchObject({
				status: "refused",
			});
		}
		expect(mail.sent).toEqual([]);
	});
});

describe("a recovery link", () => {
	it("goes to the user an admin names, authenticated by the mediator, and to nobody else", async () => {
		const { m, mail } = mediator();
		expect(
			await m.sendRecovery({
				protocol: P,
				userId: "u-editor",
				authorization: `Bearer ${ADMIN_PAT}`,
				cookie: null,
			}),
		).toEqual({ protocol: P, status: "sent" });
		expect(mail.sent).toHaveLength(1);
		expect((mail.sent[0] as { to: string }).to).toBe("editor@example.org");
		expect(tokens().map((t) => t.type)).toEqual(["recovery"]);
		for (const [request, why] of [
			[
				{ protocol: P, userId: "u-editor", authorization: `Bearer ${EDITOR_PAT}`, cookie: null },
				/not an admin/,
			],
			[
				{ protocol: P, userId: "u-nobody", authorization: `Bearer ${ADMIN_PAT}`, cookie: null },
				/no such user/,
			],
			[
				{ protocol: P, userId: "u-gone", authorization: `Bearer ${ADMIN_PAT}`, cookie: null },
				/no such user/,
			],
			[{ protocol: P, userId: "u-editor", authorization: null, cookie: null }, /no credential/],
		] as const) {
			expect(await m.sendRecovery(request)).toMatchObject({
				status: "refused",
				why: expect.stringMatching(why),
			});
		}
		expect(mail.sent).toHaveLength(1);
	});
});

describe("the broker's Worker", () => {
	it("exports its entrypoint and its Durable Object and nothing else, since workerd starts no main module with an export that is not one", async () => {
		const mod: Record<string, unknown> = await import("../src/auth-mail/worker.js");
		expect(Object.keys(mod).toSorted()).toEqual(["MailBroker", "default"]);
		expect(typeof mod.default).toBe("function");
		expect(typeof mod.MailBroker).toBe("function");
	});

	it("is a Worker whose HTTP surface is the operator's admin door only: any other path is 404, and without its Durable Object nothing is answered", async () => {
		const worker = new MailBrokerEntrypoint({ waitUntil: () => {} } as never, {} as never);
		const r = await worker.fetch(new Request("https://broker.example/"));
		expect(r.status).toBe(404);
		expect(await r.text()).toContain("emdash-auth-mail:broker");
		expect((await worker.fetch(new Request("https://broker.example/admin/state"))).status).toBe(
			404,
		);
		for (const op of [
			"send",
			"status",
			"requestMagicLink",
			"requestSignup",
			"createInvite",
			"sendRecovery",
		] as const) {
			expect(
				await worker[op]({ protocol: P, email: "admin@example.org", ip: null }),
				op,
			).toMatchObject({
				status: "refused",
				why: expect.stringMatching(/no Durable Object binding BROKER/),
			});
		}
	});

	it("checks the operator's bearer before it wakes the Durable Object: a request without the secret never reaches the site's one object", async () => {
		const secret = "s".repeat(43);
		const reached: string[] = [];
		const object = {
			fetch: async (request: Request) => {
				reached.push(`${request.method} ${new URL(request.url).pathname}`);
				return Response.json({ ok: true });
			},
			operate: async () => ({ status: "refused", why: "not asked here" }),
		};
		const namespace = { idFromName: (name: string) => name, get: () => object };
		const worker = (env: Record<string, unknown>) =>
			new MailBrokerEntrypoint({ waitUntil: () => {} } as never, env as never);
		const withSecret = worker({ BROKER: namespace, BROKER_ADMIN_SECRET: secret });
		const ask = (w: InstanceType<typeof MailBrokerEntrypoint>, auth?: string, verb = "state") =>
			w.fetch(
				new Request(`https://broker.example/admin/${verb}`, {
					method: verb === "state" ? "GET" : "POST",
					headers: auth === undefined ? {} : { authorization: auth },
					...(verb === "state" ? {} : { body: "x".repeat(10_000) }),
				}),
			);

		for (const auth of [
			undefined,
			"",
			`Bearer ${"t".repeat(43)}`,
			`Basic ${secret}`,
			`Bearer ${secret}x`,
			secret,
		]) {
			expect((await ask(withSecret, auth)).status, String(auth)).toBe(401);
			expect((await ask(withSecret, auth, "stage")).status, String(auth)).toBe(401);
		}
		// Without a secret of its own (or one too short to be the operator's), the door answers nobody.
		for (const env of [
			{ BROKER: namespace },
			{ BROKER: namespace, BROKER_ADMIN_SECRET: "short" },
			{ BROKER: namespace, BROKER_ADMIN_SECRET: 43 },
		]) {
			expect((await ask(worker(env), `Bearer ${secret}`)).status).toBe(503);
		}
		expect(reached).toEqual([]);

		// The operator's bearer is handed on to the object, which checks it again (tests/mail-broker.test.ts, "the admin door").
		const ok = await ask(withSecret, `Bearer ${secret}`);
		expect(ok.status).toBe(200);
		expect(reached).toEqual(["GET /admin/state"]);
	});
});
