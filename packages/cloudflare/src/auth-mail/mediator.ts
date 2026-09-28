/**
 * The auth-mail mediator: EmDash's own sign-in mail (magic links, sign-up
 * verification, invites and recovery links), issued and sent by a Worker of
 * its own, never by the tenant's. It runs inside the site's mail broker
 * (./broker.ts), which checks the request's capability first and runs each
 * operation in its queue, with the system lane's token of the ACTIVE
 * generation and EMAIL_SYSTEM.
 *
 * WHY. The account's mail budget keeps a reserve for sign-in mail, so a
 * site's forms cannot spend the day its login email needs. Whatever runs in
 * the tenant's Worker (its plugins, and anything that gets into it) holds that
 * Worker's credentials, so no flag, method name or second token inside it can
 * authorize the reserve. The reserve is a lane of the mail budget whose token
 * only the broker holds (in its Durable Object's storage, one per generation),
 * with the only `send_email` binding that sends system mail (EMAIL_SYSTEM).
 * The tenant's Worker holds no token and no binding that sends, and asks for
 * OPERATIONS, never for a message.
 *
 * WHAT IT ANSWERS. Four operations, each a fixed request shape (anything
 * more, a subject, a body, a link, a token or a recipient list, is refused):
 *
 *   requestMagicLink({ protocol, email, ip })
 *   requestSignup({ protocol, email, ip })
 *   createInvite({ protocol, email, role, authorization, cookie })
 *   sendRecovery({ protocol, userId, authorization, cookie })
 *
 * Each also carries the site's capability, which the broker checks, and takes
 * off, before the operation sees the request. What the broker is, and which
 * generation counts, is the broker's own `status`. Each operation, itself:
 * parses the request; rate-limits it (by the IP it is given, and always by the
 * recipient); checks eligibility (a user who exists and is not disabled; a
 * sign-up domain that is allowed; an invitee who is not a user yet);
 * authenticates the privileged ones itself from the ORIGINAL credential the
 * tenant forwards (a personal access or OAuth token, or the admin's session),
 * never from anything the tenant asserts; generates the token and persists its
 * hash (EmDash's own @emdash-cms/auth does both, with its own templates);
 * takes the system lane's place in the account's budget, through the lane the
 * broker hands it (the broker's own take, with its lost-answer and late-answer
 * handling, and its give-backs owed in its storage until the budget answers
 * them); sends through EMAIL_SYSTEM; and, when the budget or the binding
 * refuses, gives the place back and deletes the token it issued, so a link
 * that was never sent never works. Each answer is `{ protocol, status: "sent" | "skipped" | "refused" }`
 * and never carries a token, a link or an address.
 *
 * WHAT IT DOES NOT HOLD AGAINST. It shares the tenant's database (users,
 * tokens, rate limits) and its session store: whatever can write those in the
 * tenant's Worker can make a user, a session or an API token this mediator
 * then honours. That bounds what it guards to its own mail: only its fixed
 * templates, with its own tokens, to recipients its binding allows, within the
 * budget's system lane and per-recipient caps. Moving auth state out of the
 * tenant's database is the stronger boundary, and is not this.
 *
 * The site's URL, name and sender are the broker's own configuration (the
 * operator's, ./broker.ts brokerConfigFromEnv), never the tenant's.
 */

import {
	InviteError,
	Role,
	createInvite,
	hasScope,
	hashPrefixedToken,
	requestSignup,
	sendMagicLink,
	type AuthAdapter,
	type EmailMessage,
	type RoleLevel,
} from "@emdash-cms/auth";
import { createKyselyAdapter, type AuthTables } from "@emdash-cms/auth/adapters/kysely";
import { unflatten } from "devalue";
import { sql, type Kysely } from "kysely";

import { MAX_SUBJECT, displayName, headerText, mailbox } from "../plugins/email-headers.js";
import { MAIL_BROKER_PROTOCOL } from "../plugins/mail-broker-protocol.js";

/**
 * The version of the broker's RPC (./broker.ts), this mediator's operations
 * among it: what a request asks and an answer says. 2: every request carries
 * the site's generation capability, which the broker checks before anything
 * else, and the site's own mail is sent through the broker too.
 */
export const AUTH_MAIL_PROTOCOL = MAIL_BROKER_PROTOCOL;

/**
 * What the broker is, as a marker its status answers and its built module
 * carries, so a deployment can check both before it relies on it.
 */
export const AUTH_MAIL_MARKER = "emdash-auth-mail:broker;v=2";

/** The session cookie EmDash's admin signs in with (Astro's default). */
const SESSION_COOKIE = "astro-session";
/** A session id as Astro mints it (a UUID; any word run of a sane length is read). */
const SESSION_ID = /^[\w-]{1,128}$/;
/** An admin credential the mediator reads: a personal access token or an OAuth access token. */
const BEARER = /^Bearer (ec_(?:pat|oat)_[A-Za-z0-9_-]{16,})$/;
/** How many of one operation an IP, or one recipient, gets in a window. */
const RATE = { max: 3, windowSeconds: 300 };

/** What an operation came to. Never a token, a link or an address. */
export type AuthMailAnswer =
	| { protocol: typeof AUTH_MAIL_PROTOCOL; status: "sent" }
	| { protocol: typeof AUTH_MAIL_PROTOCOL; status: "skipped"; why: string }
	| { protocol: typeof AUTH_MAIL_PROTOCOL; status: "refused"; why: string };

/** The `send_email` binding the mediator sends system mail through. */
export interface SystemSendBinding {
	send(message: {
		to: string;
		from: { email: string; name?: string };
		subject: string;
		text: string;
		html?: string;
	}): Promise<unknown>;
}

/**
 * The system lane of the ACTIVE generation, as the broker hands it to the
 * mediator (./broker.ts createBudgetClient `lane`): one message's place per
 * take (the recipient's SHA-256), with its own request id, or why not; and a
 * give-back of a take whose message did not go, which the broker owes the
 * budget until the budget answers it. Neither throws for a refusal.
 */
export interface SystemLane {
	take(recipientHash: string): Promise<{ takeId: string; requestId: string } | { why: string }>;
	giveBack(take: { takeId: string; requestId: string }): Promise<void>;
}

/** The tenant's tables the mediator reads and writes: EmDash's auth tables, its API and OAuth tokens, and its rate limits. */
export interface AuthMailTables extends AuthTables {
	_emdash_api_tokens: {
		token_hash: string;
		user_id: string;
		scopes: string;
		expires_at: string | null;
	};
	_emdash_oauth_tokens: {
		token_hash: string;
		token_type: string;
		user_id: string;
		scopes: string;
		expires_at: string;
	};
	_emdash_rate_limits: { key: string; window: string; count: number };
}

/** What the mediator works with: the broker builds it for each operation (./broker.ts), with the ACTIVE generation's system lane. */
export interface AuthMailDeps {
	/** The tenant's database, through Kysely. */
	db: Kysely<AuthMailTables>;
	/** The tenant's session store (its SESSION KV), read-only here; null when the Worker has none. */
	sessions: { get(key: string): Promise<string | null> } | null;
	/** The account's mail budget's SYSTEM lane, as the broker hands it, or why not. */
	budget: SystemLane | { missing: string };
	/** EMAIL_SYSTEM, or null when the Worker has none. */
	send: SystemSendBinding | null;
	/** The operator's configuration: the site's URL and name, and the sender. */
	site: { url: string; name: string; from: string } | { missing: string };
	/** Milliseconds since the epoch. */
	now?: () => number;
	/** A log line; never given an address or a token. */
	log?: (line: string) => void;
}

const answer = {
	sent: (): AuthMailAnswer => ({ protocol: AUTH_MAIL_PROTOCOL, status: "sent" }),
	skipped: (why: string): AuthMailAnswer => ({
		protocol: AUTH_MAIL_PROTOCOL,
		status: "skipped",
		why,
	}),
	refused: (why: string): AuthMailAnswer => ({
		protocol: AUTH_MAIL_PROTOCOL,
		status: "refused",
		why,
	}),
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** A refusal thrown from inside an operation (the budget, the binding), which the operation answers. */
class Refusal extends Error {}

type FieldKind = "address" | "ip" | "credential" | "role" | "id";

/** Each operation's request: exactly these fields beside `protocol`, each of its kind. */
const SHAPES = {
	requestMagicLink: { email: "address", ip: "ip" },
	requestSignup: { email: "address", ip: "ip" },
	createInvite: {
		email: "address",
		role: "role",
		authorization: "credential",
		cookie: "credential",
	},
	sendRecovery: { userId: "id", authorization: "credential", cookie: "credential" },
} as const satisfies Record<string, Record<string, FieldKind>>;

type Operation = keyof typeof SHAPES;

const IP = /^[\da-fA-F.:]{2,45}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROLES: readonly RoleLevel[] = Object.values(Role);
const isRole = (v: unknown): v is RoleLevel => ROLES.some((r) => r === v);

/** A parsed field as the string (or null) its kind is. */
const textOf = (v: string | number | null | undefined): string | null =>
	typeof v === "string" ? v : null;

/**
 * The request as the operation's shape, or why not: a plain object in this
 * protocol, with exactly the shape's fields (a subject, a body, a link, a
 * token, a template or a recipient list is a field no operation takes), each
 * of its kind.
 */
export function parseRequest(
	operation: Operation,
	request: unknown,
): { fields: Record<string, string | number | null> } | { refused: string } {
	if (!isRecord(request)) return { refused: "the request is not an object" };
	if (request.protocol !== AUTH_MAIL_PROTOCOL) {
		return {
			refused: `the mediator speaks protocol ${AUTH_MAIL_PROTOCOL}, and the request names ${JSON.stringify(request.protocol ?? null)}`,
		};
	}
	const shape: Record<string, FieldKind> = SHAPES[operation];
	const extra = Object.keys(request).filter((k) => k !== "protocol" && !(k in shape));
	if (extra.length) {
		return {
			refused: `${operation} takes no ${extra.map((k) => JSON.stringify(k)).join(", ")}: the mediator makes the message itself`,
		};
	}
	const fields: Record<string, string | number | null> = {};
	for (const [key, kind] of Object.entries(shape)) {
		if (!(key in request)) return { refused: `${operation} needs ${key}` };
		const v = request[key];
		const ok =
			kind === "address"
				? mailbox(v) !== null && v === mailbox(v)
				: kind === "ip"
					? v === null || (typeof v === "string" && IP.test(v))
					: kind === "credential"
						? v === null || (typeof v === "string" && v.length > 0 && v.length <= 8192)
						: kind === "role"
							? isRole(v)
							: typeof v === "string" && USER_ID.test(v);
		if (!ok || !(v === null || typeof v === "string" || typeof v === "number")) {
			return {
				refused: `${operation}'s ${key} is not ${kind === "address" ? "one plain address" : `a valid ${kind}`}`,
			};
		}
		fields[key] = v;
	}
	return { fields };
}

/** SHA-256 of `text`, hex. */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One window of a rate limit, counted in the tenant's `_emdash_rate_limits`
 * table (the one EmDash's own routes count in, under keys of the mediator's
 * own): whether this call is within `max`. The counter moves either way.
 */
async function withinRate(db: Kysely<AuthMailTables>, key: string, now: number): Promise<boolean> {
	const window = new Date(
		Math.floor(now / (RATE.windowSeconds * 1000)) * RATE.windowSeconds * 1000,
	).toISOString();
	const result = await sql<{ count: number }>`
		INSERT INTO _emdash_rate_limits (key, "window", count)
		VALUES (${key}, ${window}, 1)
		ON CONFLICT (key, "window")
		DO UPDATE SET count = _emdash_rate_limits.count + 1
		RETURNING count
	`.execute(db);
	return (result.rows[0]?.count ?? 1) <= RATE.max;
}

/** The `astro-session` cookie's value, when it is a session id. */
function sessionIdOf(cookie: string): string | null {
	for (const part of cookie.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === SESSION_COOKIE) {
			const id = rest.join("=");
			return SESSION_ID.test(id) ? id : null;
		}
	}
	return null;
}

/**
 * The user an admin credential the tenant forwarded belongs to, checked here:
 * a personal access token (`Bearer ec_pat_...`) or an OAuth access token
 * (`Bearer ec_oat_...`) by its hash, unexpired, with the `admin` scope; or the
 * admin's session cookie, read from the session store. Then the user must
 * exist, be enabled and be an admin. Anything else is refused: the mediator
 * never takes the tenant's word for who asked.
 */
async function authenticate(
	deps: AuthMailDeps,
	adapter: AuthAdapter,
	credential: { authorization: string | null; cookie: string | null },
	now: number,
): Promise<{ userId: string; role: RoleLevel } | { refused: string }> {
	let userId: string | null = null;
	const { db } = deps;
	if (credential.authorization !== null) {
		const bearer = BEARER.exec(credential.authorization);
		if (!bearer?.[1]) return { refused: "the authorization is not a token the mediator takes" };
		const token = bearer[1];
		const hash = hashPrefixedToken(token);
		const row = token.startsWith("ec_pat_")
			? await db
					.selectFrom("_emdash_api_tokens")
					.select(["user_id", "scopes", "expires_at"])
					.where("token_hash", "=", hash)
					.executeTakeFirst()
			: await db
					.selectFrom("_emdash_oauth_tokens")
					.select(["user_id", "scopes", "expires_at"])
					.where("token_hash", "=", hash)
					.where("token_type", "=", "access")
					.executeTakeFirst();
		if (!row) return { refused: "the token is not one the site knows" };
		if (typeof row.expires_at === "string" && Date.parse(row.expires_at) < now) {
			return { refused: "the token has expired" };
		}
		let scopes: unknown = null;
		try {
			scopes = JSON.parse(String(row.scopes));
		} catch {
			scopes = null;
		}
		if (!Array.isArray(scopes) || !hasScope(scopes.map(String), "admin")) {
			return { refused: "the token does not carry the admin scope" };
		}
		userId = String(row.user_id);
	} else if (credential.cookie !== null) {
		const id = sessionIdOf(credential.cookie);
		if (!id) return { refused: "the cookie carries no session" };
		if (!deps.sessions)
			return { refused: "the broker has no session store (SESSION) to read the session from" };
		const raw = await deps.sessions.get(id);
		if (!raw) return { refused: "the session is not one the site knows" };
		let stored: unknown = null;
		try {
			stored = unflatten(JSON.parse(raw));
		} catch {
			stored = null;
		}
		const entry = stored instanceof Map ? stored.get("user") : null;
		if (!isRecord(entry)) return { refused: "the session holds no user" };
		if (typeof entry.expires === "number" && entry.expires < now) {
			return { refused: "the session has expired" };
		}
		const data = entry.data;
		if (!isRecord(data) || typeof data.id !== "string")
			return { refused: "the session holds no user" };
		userId = data.id;
	} else {
		return { refused: "the operation carries no credential: it is an admin's alone" };
	}
	const user = await adapter.getUserById(userId);
	if (!user || user.disabled)
		return { refused: "the credential's user does not exist or is disabled" };
	if (user.role < Role.ADMIN) return { refused: "the credential's user is not an admin" };
	return { userId: user.id, role: user.role };
}

/**
 * The mediator over its dependencies. Each operation answers what it came to
 * and never throws for a request, a refusal or a failed send.
 */
export function createAuthMailMediator(deps: AuthMailDeps) {
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});

	/**
	 * Send one message the operation built: its recipient one plain address,
	 * its subject a header, its place taken in the budget's system lane first.
	 * Throws a Refusal (after giving the place back) for anything short of a
	 * send the binding accepted.
	 */
	async function dispatch(
		message: EmailMessage,
		budget: SystemLane,
		send: SystemSendBinding,
		site: { name: string; from: string },
	): Promise<void> {
		const to = mailbox(message.to);
		if (!to || message.to !== to) throw new Refusal("the recipient is not one plain address");
		const subject = headerText(message.subject, MAX_SUBJECT);
		if (!subject) throw new Refusal("the message has no subject");
		let taken: { takeId: string; requestId: string } | { why: string };
		try {
			taken = await budget.take(await sha256Hex(to.toLowerCase()));
		} catch {
			throw new Refusal("the mail budget could not be asked");
		}
		if ("why" in taken) throw new Refusal(taken.why);
		const name = displayName(site.name);
		try {
			await send.send({
				from: name ? { email: site.from, name } : { email: site.from },
				to,
				subject,
				text: message.text,
				...(message.html ? { html: message.html } : {}),
			});
		} catch (error) {
			await budget.giveBack(taken).catch(() => log("auth-mail: a give-back was not owed"));
			const code =
				isRecord(error) && typeof error.code === "string"
					? error.code
					: error instanceof Error
						? error.name
						: "error";
			throw new Refusal(`EMAIL_SYSTEM refused it (${code})`);
		}
	}

	/**
	 * Run one operation: parse, check the Worker has what it needs, then
	 * `work`, with every token `work` issues tracked, so a send that does not
	 * go out deletes it again.
	 */
	async function run(
		operation: Operation,
		request: unknown,
		work: (ctx: {
			fields: Record<string, string | number | null>;
			adapter: AuthAdapter;
			email: (message: EmailMessage) => Promise<void>;
			baseUrl: string;
			siteName: string;
			sent: () => boolean;
		}) => Promise<AuthMailAnswer | null>,
	): Promise<AuthMailAnswer> {
		const parsed = parseRequest(operation, request);
		if ("refused" in parsed) return answer.refused(parsed.refused);
		if ("missing" in deps.site) return answer.refused(deps.site.missing);
		if ("missing" in deps.budget) return answer.refused(deps.budget.missing);
		if (!deps.send) return answer.refused("the broker has no EMAIL_SYSTEM binding");
		const budget = deps.budget;
		const send = deps.send;
		const site = deps.site;
		const base = createKyselyAdapter(deps.db);
		const issued: string[] = [];
		// The same adapter, keeping the hash of every token the operation stores.
		const adapter: AuthAdapter = {
			...base,
			createToken: async (token) => {
				issued.push(token.hash);
				await base.createToken(token);
			},
		};
		let dispatched = false;
		const email = async (message: EmailMessage) => {
			dispatched = true;
			await dispatch(message, budget, send, site);
		};
		try {
			const done = await work({
				fields: parsed.fields,
				adapter,
				email,
				baseUrl: `${site.url}/_emdash`,
				siteName: site.name,
				sent: () => dispatched,
			});
			return done ?? (dispatched ? answer.sent() : answer.skipped("nothing to send"));
		} catch (error) {
			// Nothing went out: a token it issued would be a link that works without its mail.
			for (const hash of issued) await base.deleteToken(hash).catch(() => undefined);
			if (error instanceof Refusal) return answer.refused(error.message);
			if (error instanceof InviteError) return answer.refused(error.code);
			log(`auth-mail: ${operation} failed (${error instanceof Error ? error.name : "error"})`);
			return answer.refused(`${operation} failed`);
		}
	}

	/** Whether this IP and this recipient are within the operation's rate. */
	async function rated(operation: string, ip: string | null, recipient: string): Promise<boolean> {
		const t = now();
		const who = await sha256Hex(recipient.toLowerCase());
		const byRecipient = await withinRate(
			deps.db,
			`auth-mail:${operation}:to:${who.slice(0, 32)}`,
			t,
		);
		const byIp =
			ip === null ? true : await withinRate(deps.db, `auth-mail:${operation}:ip:${ip}`, t);
		return byRecipient && byIp;
	}

	return {
		/** A sign-in link to a user who exists and is enabled; nothing for anyone else. */
		requestMagicLink: (request: unknown) =>
			run("requestMagicLink", request, async ({ fields, adapter, email, baseUrl, siteName }) => {
				const to = String(fields.email).toLowerCase();
				if (!(await rated("magic-link", textOf(fields.ip), to))) {
					return answer.skipped("rate limited");
				}
				const user = await adapter.getUserByEmail(to);
				if (!user || user.disabled) return answer.skipped("no such user");
				await sendMagicLink({ baseUrl, siteName, email }, adapter, user.email, "magic_link");
				return null;
			}),

		/** A sign-up verification to an address whose domain is allowed and that is no user yet. */
		requestSignup: (request: unknown) =>
			run("requestSignup", request, async ({ fields, adapter, email, baseUrl, siteName, sent }) => {
				const to = String(fields.email).toLowerCase().trim();
				if (!(await rated("signup", textOf(fields.ip), to))) {
					return answer.skipped("rate limited");
				}
				await requestSignup({ baseUrl, siteName, email }, adapter, to);
				return sent() ? null : answer.skipped("not eligible");
			}),

		/** An invite, from an admin the mediator authenticates itself, to someone who is not a user yet. */
		createInvite: (request: unknown) =>
			run("createInvite", request, async ({ fields, adapter, email, baseUrl, siteName }) => {
				const who = await authenticate(
					deps,
					adapter,
					{ authorization: textOf(fields.authorization), cookie: textOf(fields.cookie) },
					now(),
				);
				if ("refused" in who) return answer.refused(who.refused);
				const role = fields.role;
				if (!isRole(role)) return answer.refused("createInvite's role is not a valid role");
				if (role > who.role) return answer.refused("an admin cannot invite above their own role");
				const to = String(fields.email).toLowerCase();
				if (!(await rated("invite", null, to))) return answer.refused("rate limited");
				await createInvite({ baseUrl, siteName, email }, adapter, to, role, who.userId);
				return null;
			}),

		/** A recovery link to a user, from an admin the mediator authenticates itself. */
		sendRecovery: (request: unknown) =>
			run("sendRecovery", request, async ({ fields, adapter, email, baseUrl, siteName }) => {
				const who = await authenticate(
					deps,
					adapter,
					{ authorization: textOf(fields.authorization), cookie: textOf(fields.cookie) },
					now(),
				);
				if ("refused" in who) return answer.refused(who.refused);
				const target = await adapter.getUserById(String(fields.userId));
				if (!target || target.disabled) return answer.refused("no such user");
				if (!(await rated("recovery", null, target.email))) return answer.refused("rate limited");
				await sendMagicLink({ baseUrl, siteName, email }, adapter, target.email, "recovery");
				return null;
			}),
	};
}

export type AuthMailMediator = ReturnType<typeof createAuthMailMediator>;
