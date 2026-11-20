/**
 * Sign-in mail through the site's mail broker (the config's `systemMail`).
 *
 * With `systemMail: { binding }`, the magic-link, sign-up, invite and recovery
 * routes hand the broker the operation, the request's own credential and the
 * site's generation capability (the secret MAIL_BROKER_CAPABILITY), and build
 * nothing themselves: this Worker's email pipeline (and so every plugin hook
 * on it) never sees the message, and no auth token is minted here. With the
 * binding or the capability missing they send nothing, and never fall back to
 * the pipeline.
 */

import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	SYSTEM_MAIL_PROTOCOL,
	askMediator,
	mediatorIp,
	mediatorStatus,
	systemMailOf,
} from "../../../src/auth/system-mail.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const CONFIG = { siteUrl: "https://example.com", systemMail: { binding: "MAIL_BROKER" } };
/** The site's generation capability, as the operator binds it. */
const CAP = "cap_synthetic_0123456789abcdefghijklmnopqrstuv";
/** The env of a Worker bound to the broker `binding`, with its capability. */
const bound = (binding: unknown) => ({ MAIL_BROKER: binding, MAIL_BROKER_CAPABILITY: CAP });

type Call = { op: string; request: Record<string, unknown> };

/** A broker stand-in: records each call, answers `reply`. */
function mediator(reply: unknown = { protocol: SYSTEM_MAIL_PROTOCOL, status: "sent" }) {
	const calls: Call[] = [];
	const op =
		(name: string) =>
		async (request: Record<string, unknown>): Promise<unknown> => (
			calls.push({ op: name, request }),
			reply
		);
	return {
		calls,
		binding: {
			requestMagicLink: op("requestMagicLink"),
			requestSignup: op("requestSignup"),
			createInvite: op("createInvite"),
			sendRecovery: op("sendRecovery"),
			status: op("status"),
		},
	};
}

/** This Worker's own email pipeline: every message a plugin hook could see passes through `send`. */
function pipeline() {
	const sent: unknown[] = [];
	return {
		sent,
		email: {
			isAvailable: () => true,
			send: async (message: unknown) => (sent.push(message), { status: "sent" }),
		},
	};
}

/** The routes with the Worker env `env` (`virtual:emdash/env`). */
async function routesWith(env: Record<string, unknown>) {
	vi.resetModules();
	vi.doMock("virtual:emdash/env", () => ({ env }), { virtual: true });
	return {
		magicLink: (await import("../../../src/astro/routes/api/auth/magic-link/send.js")).POST,
		signup: (await import("../../../src/astro/routes/api/auth/signup/request.js")).POST,
		invite: (await import("../../../src/astro/routes/api/auth/invite/index.js")).POST,
		recovery: (await import("../../../src/astro/routes/api/admin/users/[id]/send-recovery.js"))
			.POST,
		settings: (await import("../../../src/astro/routes/api/settings/email.js")).GET,
	};
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
	const request = new Request(`http://test.local/_emdash/api/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7", ...headers },
		body: JSON.stringify(body),
	});
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test harness: a Cloudflare request
	(request as unknown as { cf: Record<string, unknown> }).cf = { country: "US" };
	return request;
}

type Route = (context: never) => Response | Promise<Response>;

async function call(route: Route, context: Record<string, unknown>) {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal APIContext for a route handler
	const res = await route(context as never);
	return { status: res.status, body: await res.json() };
}

describe("sign-in mail through the auth-mail mediator", () => {
	let db: Kysely<Database>;
	let admin: { id: string; role: number };
	let target: { id: string; email: string };

	beforeEach(async () => {
		db = await setupTestDatabase();
		const adapter = createKyselyAdapter(db);
		const a = await adapter.createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		admin = { id: a.id, role: a.role };
		const t = await adapter.createUser({
			email: "writer@example.com",
			name: "Writer",
			role: Role.AUTHOR,
			emailVerified: true,
		});
		target = { id: t.id, email: t.email };
		await adapter.createAllowedDomain("example.com", Role.AUTHOR);
	});

	afterEach(async () => {
		vi.doUnmock("virtual:emdash/env");
		vi.resetModules();
		await teardownTestDatabase(db);
	});

	const tokens = async () => (await db.selectFrom("auth_tokens").selectAll().execute()).length;

	it("magic link: the mediator is asked, the pipeline never sees a message, no token is minted here", async () => {
		const m = mediator();
		const p = pipeline();
		const { magicLink } = await routesWith(bound(m.binding));
		const { status, body } = await call(magicLink, {
			request: post("auth/magic-link/send", { email: "Writer@Example.com" }),
			locals: { emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(status).toBe(200);
		expect(body.data.success).toBe(true);
		expect(m.calls).toEqual([
			{
				op: "requestMagicLink",
				request: {
					protocol: SYSTEM_MAIL_PROTOCOL,
					requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
					email: "writer@example.com",
					ip: "198.51.100.7",
					capability: CAP,
				},
			},
		]);
		expect(p.sent).toEqual([]);
		expect(await tokens()).toBe(0);
	});

	it("magic link: without the binding, or without the capability, nothing is sent, and the pipeline is never the fallback", async () => {
		const m = mediator();
		for (const env of [
			{},
			{ MAIL_BROKER: m.binding },
			{ MAIL_BROKER: m.binding, MAIL_BROKER_CAPABILITY: " " },
		]) {
			const p = pipeline();
			const { magicLink } = await routesWith(env);
			const { status, body } = await call(magicLink, {
				request: post("auth/magic-link/send", { email: "writer@example.com" }),
				locals: { emdash: { db, config: CONFIG, email: p.email } },
			});
			expect(status).toBe(200);
			expect(body.data.success).toBe(true);
			expect(p.sent).toEqual([]);
			expect(await tokens()).toBe(0);
		}
		expect(m.calls).toEqual([]);
	});

	it("magic link, control: not mediated, the pipeline sends it", async () => {
		const p = pipeline();
		const { magicLink } = await routesWith({});
		await call(magicLink, {
			request: post("auth/magic-link/send", { email: "writer@example.com" }),
			locals: { emdash: { db, config: { siteUrl: "https://example.com" }, email: p.email } },
		});
		expect(p.sent).toHaveLength(1);
		expect(await tokens()).toBe(1);
	});

	it("sign-up: the mediator is asked, with no email pipeline needed here and none used", async () => {
		const m = mediator();
		const p = pipeline();
		const { signup } = await routesWith(bound(m.binding));
		const { status } = await call(signup, {
			request: post("auth/signup/request", { email: "New@example.com" }),
			locals: { emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(status).toBe(200);
		expect(m.calls.map((c) => c.op)).toEqual(["requestSignup"]);
		expect(m.calls[0]?.request).toMatchObject({ email: "new@example.com", capability: CAP });
		expect(p.sent).toEqual([]);
		expect(await tokens()).toBe(0);

		const none = await call(signup, {
			request: post("auth/signup/request", { email: "another@example.com" }),
			locals: { emdash: { db, config: CONFIG } },
		});
		expect(none.status).toBe(200);
	});

	it("sign-up: without the binding nothing is sent", async () => {
		const p = pipeline();
		const { signup } = await routesWith({});
		const { status } = await call(signup, {
			request: post("auth/signup/request", { email: "new@example.com" }),
			locals: { emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(status).toBe(200);
		expect(p.sent).toEqual([]);
		expect(await tokens()).toBe(0);
	});

	it("invite: the mediator gets the request's own credential and sends it; the pipeline never sees it", async () => {
		const m = mediator();
		const p = pipeline();
		const { invite } = await routesWith(bound(m.binding));
		const { body } = await call(invite, {
			request: post(
				"auth/invite",
				{ email: "invitee@example.com", role: Role.EDITOR },
				{ authorization: "Bearer ec_pat_synthetic", cookie: "astro-session=synthetic" },
			),
			locals: { user: admin, emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(body.data).toMatchObject({ success: true, emailed: true });
		expect(body.data).not.toHaveProperty("inviteUrl");
		expect(m.calls).toEqual([
			{
				op: "createInvite",
				request: {
					protocol: SYSTEM_MAIL_PROTOCOL,
					requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
					email: "invitee@example.com",
					role: Role.EDITOR,
					authorization: "Bearer ec_pat_synthetic",
					cookie: "astro-session=synthetic",
					capability: CAP,
				},
			},
		]);
		expect(p.sent).toEqual([]);
		expect(await tokens()).toBe(0);
	});

	it("invite: a refusal makes it here with no email and returns the link; the pipeline never sends it", async () => {
		const m = mediator({ protocol: SYSTEM_MAIL_PROTOCOL, status: "refused", why: "budget" });
		const p = pipeline();
		const { invite } = await routesWith(bound(m.binding));
		const { body } = await call(invite, {
			request: post("auth/invite", { email: "invitee@example.com" }),
			locals: { user: admin, emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(body.data).toMatchObject({ success: true, emailed: false });
		expect(body.data.inviteUrl).toContain("/invite/accept?token=");
		expect(p.sent).toEqual([]);
	});

	it("invite, CURE 4: when whether it was emailed is not known (the broker's unknown, a call lost twice, an answer that is not the broker's), no invite is made here, no link comes back, and it is never said to be unsent; the retry names the same request id", async () => {
		const lost = () => {
			const calls: Array<Record<string, unknown>> = [];
			const binding = {
				...mediator().binding,
				createInvite: async (request: Record<string, unknown>) => {
					calls.push(request);
					throw new Error("the connection was lost");
				},
			};
			return { calls, binding };
		};
		const twice = lost();
		for (const [what, binding] of [
			[
				"the broker's unknown",
				mediator({ protocol: SYSTEM_MAIL_PROTOCOL, status: "unknown", why: "did not finish" })
					.binding,
			],
			["a call lost twice", twice.binding],
			["another protocol", mediator({ protocol: 2, status: "refused", why: "x" }).binding],
		] as const) {
			const p = pipeline();
			const { invite } = await routesWith(bound(binding));
			const { status, body } = await call(invite, {
				request: post("auth/invite", { email: "invitee@example.com" }),
				locals: { user: admin, emdash: { db, config: CONFIG, email: p.email } },
			});
			expect(status, what).toBe(502);
			expect(body.error.code, what).toBe("INVITE_EMAIL_UNKNOWN");
			expect(body.error.message, what).toMatch(/may have been emailed/);
			expect(JSON.stringify(body), what).not.toContain("inviteUrl");
			expect(await tokens(), what).toBe(0);
			expect(p.sent, what).toEqual([]);
		}
		// The retry of the lost call is the same operation: the same request id.
		expect(twice.calls).toHaveLength(2);
		expect(twice.calls[0]!.requestId).toBe(twice.calls[1]!.requestId);
	});

	it("recovery, CURE 4: a link not known to be sent is RECOVERY_SEND_UNKNOWN, never RECOVERY_NOT_SENT", async () => {
		const m = mediator({
			protocol: SYSTEM_MAIL_PROTOCOL,
			status: "unknown",
			why: "did not finish",
		});
		const { recovery } = await routesWith(bound(m.binding));
		const r = await call(recovery, {
			request: post(`admin/users/${target.id}/send-recovery`, {}),
			params: { id: target.id },
			locals: { user: admin, emdash: { db, config: CONFIG, email: pipeline().email } },
		});
		expect(r.status).toBe(502);
		expect(r.body.error.code).toBe("RECOVERY_SEND_UNKNOWN");
		expect(r.body.error.message).toMatch(/may have been sent/);
	});

	it("invite: without the binding the link comes back and nothing is sent", async () => {
		const p = pipeline();
		const { invite } = await routesWith({});
		const { body } = await call(invite, {
			request: post("auth/invite", { email: "invitee@example.com" }),
			locals: { user: admin, emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(body.data).toMatchObject({ success: true, emailed: false });
		expect(typeof body.data.inviteUrl).toBe("string");
		expect(p.sent).toEqual([]);
	});

	it("recovery: the mediator gets the target and the credential; a refusal is an error, never a pipeline send", async () => {
		const m = mediator();
		const p = pipeline();
		const { recovery } = await routesWith(bound(m.binding));
		const sent = await call(recovery, {
			request: post(
				`admin/users/${target.id}/send-recovery`,
				{},
				{ cookie: "astro-session=synthetic" },
			),
			params: { id: target.id },
			locals: { user: admin, emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(sent.status).toBe(200);
		expect(m.calls).toEqual([
			{
				op: "sendRecovery",
				request: {
					protocol: SYSTEM_MAIL_PROTOCOL,
					requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
					userId: target.id,
					authorization: null,
					cookie: "astro-session=synthetic",
					capability: CAP,
				},
			},
		]);

		const refusing = mediator({
			protocol: SYSTEM_MAIL_PROTOCOL,
			status: "refused",
			why: "rate limited",
		});
		const again = await routesWith(bound(refusing.binding));
		const refused = await call(again.recovery, {
			request: post(`admin/users/${target.id}/send-recovery`, {}),
			params: { id: target.id },
			locals: { user: admin, emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(refused.status).toBe(502);
		expect(refused.body.error.code).toBe("RECOVERY_NOT_SENT");

		const missing = await routesWith({});
		const none = await call(missing.recovery, {
			request: post(`admin/users/${target.id}/send-recovery`, {}),
			params: { id: target.id },
			locals: { user: admin, emdash: { db, config: CONFIG, email: p.email } },
		});
		expect(none.status).toBe(502);
		expect(p.sent).toEqual([]);
		expect(await tokens()).toBe(0);
	});

	it("settings: says whether sign-in mail is mediated, and reads the broker's status for the site's capability strictly", async () => {
		const m = mediator({
			protocol: SYSTEM_MAIL_PROTOCOL,
			marker: "emdash-auth-mail:broker;v=3",
			seq: 7,
			tenant: "demo",
			deployment: "artifact:code",
			capability: "staged",
			generation: 3,
			capabilityHash: "c".repeat(64),
			send: { plugin: true, system: true },
			site: true,
			budget: {
				plugin: { ok: true, tenant: "demo", lane: "plugin", generation: 3, state: "staged" },
				system: {
					ok: true,
					tenant: "demo",
					lane: "system",
					generation: 3,
					state: "staged",
					token: "must-not-pass",
				},
			},
			extra: "must-not-pass",
		});
		const hooks = { getExclusiveHookProviders: () => [], getHookProviders: () => [] };
		const user = { id: admin.id, role: Role.ADMIN };
		const { settings } = await routesWith(bound(m.binding));
		const { body } = await call(settings, {
			locals: { user, emdash: { db, config: CONFIG, hooks, email: pipeline().email } },
		});
		expect(body.data.systemMail).toEqual({
			mediated: true,
			binding: "MAIL_BROKER",
			present: true,
			status: {
				ok: true,
				marker: "emdash-auth-mail:broker;v=3",
				tenant: "demo",
				deployment: "artifact:code",
				capability: "staged",
				generation: 3,
				capabilityHash: "c".repeat(64),
				send: true,
				site: true,
				budget: { ok: true, tenant: "demo", lane: "system", generation: 3, state: "staged" },
			},
		});
		// The status was asked with the capability.
		expect(m.calls).toEqual([
			{ op: "status", request: { protocol: SYSTEM_MAIL_PROTOCOL, capability: CAP } },
		]);

		const missing = await routesWith({});
		const none = await call(missing.settings, {
			locals: { user, emdash: { db, config: CONFIG, hooks } },
		});
		expect(none.body.data.systemMail).toMatchObject({ mediated: true, present: false });
		const noCap = await routesWith({ MAIL_BROKER: m.binding });
		const unkeyed = await call(noCap.settings, {
			locals: { user, emdash: { db, config: CONFIG, hooks } },
		});
		expect(unkeyed.body.data.systemMail).toMatchObject({
			mediated: true,
			present: false,
			why: expect.stringMatching(/MAIL_BROKER_CAPABILITY/),
		});
		const plain = await call(missing.settings, {
			locals: { user, emdash: { db, config: {}, hooks } },
		});
		expect(plain.body.data.systemMail).toEqual({ mediated: false });
	});
});

describe("systemMailOf / askMediator", () => {
	const env = (e: Record<string, unknown>) => async () => e;

	it("is not mediated without systemMail, and never reads the env", async () => {
		const loadEnv = vi.fn(env({}));
		expect(await systemMailOf({}, loadEnv)).toEqual({ mediated: false });
		expect(await systemMailOf(undefined, loadEnv)).toEqual({ mediated: false });
		expect(loadEnv).not.toHaveBeenCalled();
	});

	it("is missing for a binding that is not every operation callable", async () => {
		const partial = { requestMagicLink: async () => ({}) };
		const got = await systemMailOf(CONFIG, env(bound(partial)));
		expect(got).toMatchObject({ mediated: true, binding: "MAIL_BROKER" });
		expect(got).toHaveProperty("missing");
		expect(await systemMailOf({ systemMail: { binding: "" } }, env({}))).toHaveProperty("missing");
		expect(
			await systemMailOf(CONFIG, async () => Promise.reject(new Error("no env"))),
		).toHaveProperty("missing");
		expect(await systemMailOf(CONFIG, env({ MAIL_BROKER: mediator().binding }))).toHaveProperty(
			"missing",
		);
		// The capability is found under the name the config gives, and added to every call.
		const m = mediator();
		const named = await systemMailOf(
			{ systemMail: { binding: "MAIL_BROKER", capability: "OTHER_CAP" } },
			env({ MAIL_BROKER: m.binding, OTHER_CAP: CAP }),
		);
		expect(named).toHaveProperty("mediator");
		if (!("mediator" in named)) throw new Error("not mediated");
		await named.mediator.requestMagicLink({
			protocol: SYSTEM_MAIL_PROTOCOL,
			requestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
			email: "a@example.com",
			ip: null,
		});
		await named.mediator.status({ protocol: SYSTEM_MAIL_PROTOCOL });
		expect(m.calls.map((c) => c.request.capability)).toEqual([CAP, CAP]);
	});

	it("reads only the mediator's own answer as sent, skipped or refused; anything else, a call lost twice included, is unknown, never refused", async () => {
		const ask = (a: unknown) => askMediator(async () => a);
		expect(await ask({ protocol: SYSTEM_MAIL_PROTOCOL, status: "sent" })).toEqual({
			status: "sent",
		});
		expect(await ask({ protocol: 1, status: "sent" })).toMatchObject({ status: "unknown" });
		expect(await ask({ status: "sent" })).toMatchObject({ status: "unknown" });
		expect(await ask({ protocol: SYSTEM_MAIL_PROTOCOL, status: "ok" })).toMatchObject({
			status: "unknown",
		});
		expect(await ask("sent")).toMatchObject({ status: "unknown" });
		expect(
			await ask({ protocol: SYSTEM_MAIL_PROTOCOL, status: "unknown", why: "did not finish" }),
		).toEqual({ status: "unknown", why: "did not finish" });
		const ids: string[] = [];
		expect(
			await askMediator(async (requestId) => {
				ids.push(requestId);
				throw new Error("RPC failed");
			}),
		).toMatchObject({ status: "unknown" });
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe(ids[1]);
		// One lost answer, then the broker's answer to the same request id.
		let n = 0;
		expect(
			await askMediator(async () => {
				if (n++ === 0) throw new Error("RPC failed");
				return { protocol: SYSTEM_MAIL_PROTOCOL, status: "refused", why: "rate limited" };
			}),
		).toEqual({ status: "refused", why: "rate limited" });
		expect(
			await ask({ protocol: SYSTEM_MAIL_PROTOCOL, status: "skipped", why: "no user" }),
		).toEqual({
			status: "skipped",
			why: "no user",
		});
	});

	it("passes only an IP to the mediator", () => {
		expect(mediatorIp("198.51.100.7")).toBe("198.51.100.7");
		expect(mediatorIp("2001:db8::1")).toBe("2001:db8::1");
		expect(mediatorIp(null)).toBeNull();
		expect(mediatorIp("not an ip; drop")).toBeNull();
	});

	it("reads a status that throws or answers another protocol as not ok", async () => {
		const throwing = {
			...mediator().binding,
			status: async () => {
				throw new Error("down");
			},
		};
		expect(await mediatorStatus(throwing)).toMatchObject({ ok: false });
		expect(await mediatorStatus(mediator({ protocol: 9, marker: "x" }).binding)).toMatchObject({
			ok: false,
		});
	});
});
