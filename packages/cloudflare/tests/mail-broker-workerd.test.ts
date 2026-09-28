/**
 * The mail broker's Worker (src/auth-mail/worker.ts) in workerd itself: bundled
 * by wrangler as an operator's build bundles it (`wrangler deploy --dry-run`,
 * its Durable Object declared), started through Miniflare, and reached from a
 * site's Worker through a REAL service binding. Beside it, a mail budget Worker
 * that speaks protocol 3 and a Worker that stands for both send_email bindings
 * and can hold a send open. tests/mail-broker.test.ts proves the broker over
 * doubles; this proves the same door, fence and storage in the runtime, where a
 * Durable Object's own ordering lets another request in while a call awaits.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUTH_MAIL_MARKER, AUTH_MAIL_PROTOCOL } from "../src/auth-mail/mediator.js";

const P = AUTH_MAIL_PROTOCOL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/** 32 random bytes, base64url: a capability, a budget token or the admin secret, as the operator mints them. */
const mint = () =>
	btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
const ADMIN = mint();
const TENANT = "acme";
const ALLOWED = "office@example.org";

interface Worker {
	fetch(url: string, init?: RequestInit): Promise<Response>;
}
interface Miniflare {
	getWorker(name: string): Promise<Worker>;
	dispose(): Promise<void>;
}
interface MiniflareModule {
	Miniflare: new (options: unknown) => Miniflare;
	convertV4MiniflareOptions?: (options: unknown) => unknown;
}

/** The site's Worker: each request names one of the broker's methods and its argument, and is answered with what the broker answered. */
const SITE_WORKER = `
export default {
	async fetch(request, env) {
		const { method, args } = await request.json();
		try { return Response.json(await env.MAIL_BROKER[method](args)); }
		catch (e) { return Response.json({ thrown: String((e && e.message) || e) }); }
	},
};`;

/** The account's mail budget in protocol 3, in memory: tokens (by hash) in generations, a take per request id, a refund only by the token that took. */
const BUDGET_WORKER = `
import { WorkerEntrypoint } from "cloudflare:workers";
const tokens = new Map(); const takes = new Map(); const byRequest = new Map(); let n = 0;
async function hash(t) {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export default class Budget extends WorkerEntrypoint {
	async take(r) {
		if (r.protocol !== 3) return { ok: false, protocol: 3, scope: "protocol" };
		const k = await hash(r.token); const t = tokens.get(k);
		if (!t) return { ok: false, protocol: 3, scope: "token" };
		if (t.state !== "active") return { ok: false, protocol: 3, scope: "generation" };
		const seen = byRequest.get(k + r.requestId);
		if (seen) return { ok: true, protocol: 3, ...seen, replayed: true };
		const takeId = "2026-01-01:" + String(++n).padStart(36, "0");
		const a = { takeId, lane: t.lane, generation: t.generation };
		byRequest.set(k + r.requestId, a); takes.set(takeId, { by: k, refunded: false });
		return { ok: true, protocol: 3, ...a };
	}
	async refund(r) {
		const t = takes.get(r.takeId);
		if (!t || t.by !== (await hash(r.token))) return { ok: false, protocol: 3, scope: "take" };
		const was = t.refunded; t.refunded = true;
		return { ok: true, protocol: 3, refunded: was ? 0 : 1 };
	}
	async report(r) {
		const t = tokens.get(await hash(r.token));
		return t ? { ok: true, protocol: 3, ...t, caps: {} } : { ok: false, protocol: 3, scope: "token" };
	}
	async fetch(request) {
		const b = await request.json(); const path = new URL(request.url).pathname;
		if (path === "/stage") {
			for (const [k, v] of tokens) if (v.tenant === b.tenant) tokens.delete(k);
			tokens.set(b.plugin, { tenant: b.tenant, lane: "plugin", generation: b.generation, state: "staged" });
			tokens.set(b.system, { tenant: b.tenant, lane: "system", generation: b.generation, state: "staged" });
		}
		if (path === "/activate") for (const v of tokens.values()) if (v.generation === b.generation) v.state = "active";
		return Response.json({ ok: true, counted: [...takes.values()].filter((t) => !t.refunded).length });
	}
}`;

/** Both send_email bindings: each message kept; after /hold the next send waits inside the call until /release. */
const SEND_WORKER = `
import { WorkerEntrypoint } from "cloudflare:workers";
const sent = []; let holding = false; let entered = false;
export default class Send extends WorkerEntrypoint {
	async send(message) {
		if (holding) { entered = true; while (holding) await new Promise((r) => setTimeout(r, 10)); }
		sent.push(message);
		return { messageId: "m" + sent.length };
	}
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/hold") { holding = true; entered = false; }
		if (path === "/release") holding = false;
		return Response.json({ entered, sent });
	}
}`;

let work = "";
let bundle = "";
let persist = "";
let mfModule: MiniflareModule;
let mf: Miniflare | null = null;

/** The four Workers, the broker's storage kept in `persist` across a restart. */
function options() {
	const modules = readdirSync(bundle).filter((f) => /\.m?js$/.test(f));
	const o = {
		durableObjectsPersist: persist,
		resourcePersistencePath: persist,
		workers: [
			{
				name: "site",
				modules: true,
				script: SITE_WORKER,
				compatibilityDate: "2026-04-01",
				serviceBindings: { MAIL_BROKER: "broker" },
			},
			{
				name: "broker",
				modules: modules.map((f) => ({ type: "ESModule", path: join(bundle, f) })),
				modulesRoot: bundle,
				compatibilityDate: "2026-04-01",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: { BROKER: { className: "MailBroker", useSQLite: true } },
				serviceBindings: { MAIL_BUDGET: "budget", EMAIL_PLUGIN: "send", EMAIL_SYSTEM: "send" },
				bindings: {
					BROKER_TENANT: TENANT,
					BROKER_DEPLOYMENT: "g1:probe",
					BROKER_RECIPIENTS: JSON.stringify([ALLOWED]),
					BROKER_ADMIN_SECRET: ADMIN,
					AUTH_MAIL_SITE_URL: "https://acme.example.org",
					AUTH_MAIL_SITE_NAME: "Acme",
					AUTH_MAIL_FROM: "notify@mail.example.org",
				},
			},
			{ name: "budget", modules: true, script: BUDGET_WORKER, compatibilityDate: "2026-04-01" },
			{ name: "send", modules: true, script: SEND_WORKER, compatibilityDate: "2026-04-01" },
		],
	};
	return mfModule.convertV4MiniflareOptions ? mfModule.convertV4MiniflareOptions(o) : o;
}

function running(): Miniflare {
	if (!mf) throw new Error("Miniflare is not running");
	return mf;
}

/** A call of the site's Worker to its broker, through the service binding. */
async function call(method: string, args: unknown): Promise<Record<string, unknown>> {
	const site = await running().getWorker("site");
	const r = await site.fetch("https://site.example/", {
		method: "POST",
		body: JSON.stringify({ method, args }),
	});
	return (await r.json()) as Record<string, unknown>;
}

async function admin(verb: string, body?: unknown, auth: string | null = `Bearer ${ADMIN}`) {
	const broker = await running().getWorker("broker");
	const r = await broker.fetch(`https://broker.example/admin/${verb}`, {
		method: body === undefined ? "GET" : "POST",
		headers: auth ? { authorization: auth } : {},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

async function budget(path: string, body: unknown) {
	const w = await running().getWorker("budget");
	return (await (
		await w.fetch(`https://budget.example${path}`, {
			method: "POST",
			body: JSON.stringify(body),
		})
	).json()) as Record<string, unknown>;
}

async function sendBinding(path = "/") {
	const w = await running().getWorker("send");
	return (await (await w.fetch(`https://send.example${path}`)).json()) as {
		entered: boolean;
		sent: Array<Record<string, unknown>>;
	};
}

const creds = () => ({ capability: mint(), plugin: mint(), system: mint() });
type Creds = ReturnType<typeof creds>;

const send = (capability: string, message: Record<string, unknown> = {}) =>
	call("send", {
		protocol: P,
		capability,
		requestId: mint().slice(0, 32),
		message: { to: ALLOWED, subject: "New submission", text: "Someone wrote in.", ...message },
	});

const stageInBudget = (g: number, c: Creds) =>
	budget("/stage", { tenant: TENANT, generation: g, plugin: sha(c.plugin), system: sha(c.system) });

const stage = (g: number, c: Creds, expectActive: number | null) =>
	admin("stage", {
		generation: g,
		capabilityHash: sha(c.capability),
		tokens: { plugin: c.plugin, system: c.system },
		expectActive,
	});

const activate = (g: number, c: Creds, expectActive: number | null) =>
	admin("activate", { generation: g, capabilityHash: sha(c.capability), expectActive });

const g1 = creds();
const g2 = creds();
/** The last `seq` the broker answered before its restart. */
let lastSeq = 0;

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), "mail-broker-workerd-"));
	bundle = join(work, "bundle");
	persist = join(work, "persist");
	mkdirSync(persist);
	const config = join(work, "wrangler.json");
	writeFileSync(
		config,
		JSON.stringify({
			name: "auth-mail",
			main: join(ROOT, "src/auth-mail/worker.ts"),
			compatibility_date: "2026-04-01",
			compatibility_flags: ["nodejs_compat"],
			durable_objects: { bindings: [{ name: "BROKER", class_name: "MailBroker" }] },
			migrations: [{ tag: "v1", new_sqlite_classes: ["MailBroker"] }],
			upload_source_maps: false,
		}),
	);
	const require = createRequire(import.meta.url);
	const wranglerPackage = require.resolve("wrangler/package.json");
	execFileSync(
		process.execPath,
		[
			join(dirname(wranglerPackage), "bin/wrangler.js"),
			"deploy",
			"--config",
			config,
			"--dry-run",
			"--outdir",
			bundle,
		],
		{ cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" },
	);
	const miniflare = createRequire(wranglerPackage).resolve("miniflare");
	mfModule = (await import(pathToFileURL(miniflare).href)) as MiniflareModule;
	mf = new mfModule.Miniflare(options());
}, 180_000);

afterAll(async () => {
	await mf?.dispose();
	if (work) rmSync(work, { recursive: true, force: true });
});

describe("the broker's Worker in workerd", () => {
	it("answers its status, its admin door, a staged and an active generation through a real service binding, and sends exactly the envelope", async () => {
		expect(await call("status", { protocol: P, capability: g1.capability })).toMatchObject({
			protocol: P,
			marker: AUTH_MAIL_MARKER,
			tenant: TENANT,
			generations: { active: null, staged: null },
			capability: "unknown",
		});
		expect((await admin("state", undefined, null)).status).toBe(401);
		expect((await admin("state", undefined, `Bearer ${mint()}`)).status).toBe(401);
		const broker = await running().getWorker("broker");
		expect((await broker.fetch("https://broker.example/send")).status).toBe(404);

		await stageInBudget(1, g1);
		expect((await stage(1, g1, null)).status).toBe(200);
		expect(await send(g1.capability)).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/staged, not active/),
		});
		expect((await activate(1, g1, null)).status).toBe(200);
		await budget("/activate", { generation: 1 });
		expect(await send(g1.capability)).toMatchObject({ protocol: P, status: "sent" });
		expect(await send(g1.capability, { from: "other@example.org" })).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/takes no "from"/),
		});
		expect(await send(g1.capability, { to: "stranger@example.net" })).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not on the broker's recipient list/),
		});
		expect((await sendBinding()).sent).toEqual([
			{
				from: { email: "notify@mail.example.org", name: "Acme" },
				to: ALLOWED,
				subject: "New submission",
				text: "Someone wrote in.",
			},
		]);
		expect(await call("status", { protocol: P, capability: g1.capability })).toMatchObject({
			capability: "active",
			generation: 1,
			budget: { plugin: { ok: true, lane: "plugin", state: "active" } },
		});
	}, 60_000);

	it("THE FENCE: with G1's send held inside the send binding, activate(G2) stays pending; released, G1 is sent first and only then does the activation answer; after it G1 is refused and G2 sent", async () => {
		await sendBinding("/hold");
		const inFlight = send(g1.capability);
		// Awaited below; handled here too, so a failure before then leaves no rejection behind.
		void inFlight.catch(() => undefined);
		for (let i = 0; i < 100 && !(await sendBinding()).entered; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect((await sendBinding()).entered).toBe(true);
		await stageInBudget(2, g2);
		const answered: { at: number | null } = { at: null };
		const activation = stage(2, g2, 1).then(async (staged) => {
			expect(staged.status).toBe(200);
			const a = await activate(2, g2, 1);
			answered.at = Date.now();
			return a;
		});
		await new Promise((r) => setTimeout(r, 300));
		expect(answered.at, "the activation answered while G1's send was held").toBeNull();
		const releasedAt = Date.now();
		await sendBinding("/release");
		const sent = await inFlight;
		const ack = await activation;
		expect(sent).toMatchObject({ status: "sent" });
		expect(ack.status).toBe(200);
		expect(answered.at).toBeGreaterThanOrEqual(releasedAt);
		expect(Number(sent.seq)).toBeLessThan(Number(ack.body.seq));
		await budget("/activate", { generation: 2 });
		expect(await send(g1.capability)).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not this site's active generation's/),
		});
		const last = await send(g2.capability);
		expect(last).toMatchObject({ status: "sent" });
		lastSeq = Number(last.seq);
	}, 60_000);

	it("keeps the active generation over a restart: a new runtime over the same storage answers G2 active, numbers on, sends with it and refuses G1", async () => {
		await running().dispose();
		mf = new mfModule.Miniflare(options());
		// The budget double keeps nothing across the restart: G2 is staged and activated in it again.
		await stageInBudget(2, g2);
		await budget("/activate", { generation: 2 });
		const state = await admin("state");
		expect(state.body).toMatchObject({
			active: { generation: 2, capabilityHash: sha(g2.capability) },
			staged: null,
			highest: 2,
		});
		expect(Number(state.body.seq)).toBeGreaterThan(lastSeq);
		expect(JSON.stringify(state.body)).not.toContain(g2.plugin);
		expect(await send(g2.capability)).toMatchObject({ status: "sent" });
		expect(await send(g1.capability)).toMatchObject({
			status: "refused",
			why: expect.stringMatching(/not this site's active generation's/),
		});
	}, 60_000);
});
