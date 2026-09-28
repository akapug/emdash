/**
 * The site's mail broker as a Worker of its own (see ./broker.ts): the one
 * door the site's mail goes out through. One per site, deployed by the
 * operator; the site's Worker reaches it only through a service binding.
 *
 * Its two exports:
 *   MailBroker   the Durable Object (one per site, idFromName("broker")) that
 *                holds the generations, the queue, both budget tokens (in its
 *                own storage) and the send bindings, and does everything;
 *   default      the entrypoint the site's service binding calls: RPC methods
 *                that hand the request to the object, and `fetch`, the
 *                operator's admin door (behind BROKER_ADMIN_SECRET), which is
 *                answered by the object too. Anything else is 404.
 *
 * Its env (the operator provisions it; the site's Worker has none of it):
 *   BROKER               the Durable Object namespace (class MailBroker, SQLite)
 *   EMAIL_PLUGIN         send_email: the site's own mail (forms, comments, the admin's test)
 *   EMAIL_SYSTEM         send_email: its sign-in mail
 *   MAIL_BUDGET          service binding to the account's mail-budget Worker
 *   DB, SESSION          the site's D1 and session KV (the auth operations)
 *   BROKER_TENANT        the site's slug, as the budget knows it
 *   BROKER_DEPLOYMENT    what the operator says this deployment is (the status echoes it)
 *   BROKER_RECIPIENTS    a JSON list of the addresses a send may go to
 *   BROKER_ADMIN_SECRET  the admin door's bearer (secret)
 *   AUTH_MAIL_SITE_URL, AUTH_MAIL_SITE_NAME, AUTH_MAIL_FROM   the site's URL, name and the sender
 */

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

import {
	adminRefusal,
	brokerConfigFromEnv,
	createMailBroker,
	type BrokerStore,
	type MailBroker as Broker,
} from "./broker.js";
import type { AuthMailTables } from "./mediator.js";

// Nothing but these two classes is exported: workerd reads every export of a
// Worker's main module as an entrypoint, and refuses to start one whose export
// is not a function or handler (measured 2026-09-27: "Incorrect type for map
// entry 'AUTH_MAIL_MARKER'"). The marker and protocol come from ./auth-mail.

/** The Durable Object's SQLite storage as the broker's synchronous store: one row per key, the value JSON. */
function sqlStore(sql: SqlStorage): BrokerStore {
	sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	return {
		get: (key) => {
			const [row] = sql.exec("SELECT value FROM kv WHERE key = ?", key).toArray();
			return typeof row?.value === "string" ? (JSON.parse(row.value) as unknown) : undefined;
		},
		put: (key, value) =>
			void sql.exec(
				"INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				key,
				JSON.stringify(value),
			),
		delete: (key) => void sql.exec("DELETE FROM kv WHERE key = ?", key),
		keys: (prefix, limit) =>
			sql
				.exec(
					"SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?",
					prefix,
					`${prefix}￿`,
					limit,
				)
				.toArray()
				.flatMap((r) => (typeof r.key === "string" ? [r.key] : [])),
	};
}

/** The broker's Durable Object: one per site, the only place its mail is sent from. */
export class MailBroker extends DurableObject<Record<string, unknown>> {
	#broker: Broker;

	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- DB is the D1 binding the operator provisions
		const database = env.DB as ConstructorParameters<typeof D1Dialect>[0]["database"] | undefined;
		const sessions = env.SESSION;
		this.#broker = createMailBroker({
			store: sqlStore(ctx.storage.sql),
			config: brokerConfigFromEnv(env),
			db: database ? new Kysely<AuthMailTables>({ dialect: new D1Dialect({ database }) }) : null,
			sessions:
				typeof sessions === "object" &&
				sessions !== null &&
				typeof Reflect.get(sessions, "get") === "function"
					? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- checked above: get is callable
						(sessions as { get(key: string): Promise<string | null> })
					: null,
			extend: (work) => ctx.waitUntil(work),
			log: (line) => console.warn(line),
		});
	}

	/** One call of the site's, by name: one of the broker's request methods, and nothing else. */
	operate(operation: string, request: unknown): Promise<unknown> {
		const b = this.#broker;
		switch (operation) {
			case "send":
				return b.send(request);
			case "requestMagicLink":
				return b.requestMagicLink(request);
			case "requestSignup":
				return b.requestSignup(request);
			case "createInvite":
				return b.createInvite(request);
			case "sendRecovery":
				return b.sendRecovery(request);
			case "status":
				return b.status(request);
			default:
				return Promise.resolve({ status: "refused", why: "no such operation" });
		}
	}

	/** The operator's admin door. */
	override fetch(request: Request): Promise<Response> {
		return this.#broker.admin(request);
	}
}

/** The object's stub, as the entrypoint calls it. */
interface BrokerStub {
	operate(operation: string, request: unknown): Promise<unknown>;
	fetch(request: Request): Promise<Response>;
}

/** The entrypoint the site's service binding calls: each method hands its request to the broker's one object. */
export default class MailBrokerEntrypoint extends WorkerEntrypoint<Record<string, unknown>> {
	#object(): BrokerStub | null {
		const ns = this.env.BROKER;
		if (
			typeof ns !== "object" ||
			ns === null ||
			typeof Reflect.get(ns, "idFromName") !== "function"
		)
			return null;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- BROKER is the Durable Object namespace of MailBroker, checked above
		const namespace = ns as DurableObjectNamespace;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the stub of MailBroker above
		return namespace.get(namespace.idFromName("broker")) as unknown as BrokerStub;
	}

	#call(operation: string, request: unknown): Promise<unknown> {
		const object = this.#object();
		if (!object) {
			return Promise.resolve({
				status: "refused",
				why: "the broker has no Durable Object binding BROKER",
			});
		}
		return object.operate(operation, request);
	}

	send(request: unknown) {
		return this.#call("send", request);
	}

	requestMagicLink(request: unknown) {
		return this.#call("requestMagicLink", request);
	}

	requestSignup(request: unknown) {
		return this.#call("requestSignup", request);
	}

	createInvite(request: unknown) {
		return this.#call("createInvite", request);
	}

	sendRecovery(request: unknown) {
		return this.#call("sendRecovery", request);
	}

	status(request: unknown) {
		return this.#call("status", request);
	}

	/**
	 * The operator's admin door (/admin/...), answered by the object; nothing
	 * else answers over HTTP. The bearer is checked here first: the route is
	 * public, and a request without the operator's secret never reaches the
	 * site's one object, so a flood of them cannot hold up the site's mail.
	 */
	override async fetch(request: Request): Promise<Response> {
		const object = this.#object();
		if (!new URL(request.url).pathname.startsWith("/admin/") || !object) {
			return new Response("emdash-auth-mail:broker: not found", { status: 404 });
		}
		return (await adminRefusal(request, this.env.BROKER_ADMIN_SECRET)) ?? object.fetch(request);
	}
}
