/**
 * The auth-mail mediator as a Worker of its own (see ./mediator.ts): RPC only,
 * through the tenant Worker's service binding. It has no HTTP surface: its
 * `fetch` answers 404 to everything, and its workers.dev route is off.
 *
 * Its env (the operator provisions it; the tenant's Worker has none of it):
 *   DB                   the tenant's D1
 *   SESSION              the tenant's session KV (read only here)
 *   MAIL_BUDGET          service binding to the account's mail-budget Worker
 *   MAIL_BUDGET_TOKEN    the tenant's SYSTEM lane token (secret)
 *   EMAIL_SYSTEM         the send_email binding system mail goes through
 *   AUTH_MAIL_SITE_URL   the site's https origin, for the links
 *   AUTH_MAIL_SITE_NAME  the site's name, for the templates
 *   AUTH_MAIL_FROM       the sender
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

import {
	AUTH_MAIL_MARKER,
	authMailDepsFromEnv,
	createAuthMailMediator,
	type AuthMailMediator,
	type AuthMailTables,
} from "./mediator.js";

export { AUTH_MAIL_MARKER, AUTH_MAIL_PROTOCOL } from "./mediator.js";

/** The mediator's Worker entrypoint: the four operations and the status, as RPC methods. */
export default class AuthMail extends WorkerEntrypoint<Record<string, unknown>> {
	#mediator(): AuthMailMediator {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- DB is the D1 binding the operator provisions
		const database = this.env.DB as ConstructorParameters<typeof D1Dialect>[0]["database"];
		const db = new Kysely<AuthMailTables>({ dialect: new D1Dialect({ database }) });
		return createAuthMailMediator(
			authMailDepsFromEnv(this.env, {
				db,
				extend: (work) => this.ctx.waitUntil(work),
				log: (line) => console.warn(line),
			}),
		);
	}

	requestMagicLink(request: unknown) {
		return this.#mediator().requestMagicLink(request);
	}

	requestSignup(request: unknown) {
		return this.#mediator().requestSignup(request);
	}

	createInvite(request: unknown) {
		return this.#mediator().createInvite(request);
	}

	sendRecovery(request: unknown) {
		return this.#mediator().sendRecovery(request);
	}

	status(request: unknown) {
		return this.#mediator().status(request);
	}

	/** No HTTP surface: the operations are RPC, through the tenant's service binding only. */
	override fetch(): Response {
		return new Response(`${AUTH_MAIL_MARKER}: not found`, { status: 404 });
	}
}
