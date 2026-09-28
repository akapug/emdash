/**
 * The version of the site's mail broker's RPC (../auth-mail/broker.ts): what
 * a send, an auth operation and a status ask and answer. The site's email
 * provider (cloudflare-email.ts) and EmDash's own sign-in routes name it in
 * every request, and an answer that does not name it is not the broker's.
 *
 * 2: every request carries the site's generation capability, which the broker
 * checks before anything else (1 was the auth-mail mediator's, before the site's
 * own mail went through it too). No imports, so the broker's Worker carries it
 * without EmDash.
 */
export const MAIL_BROKER_PROTOCOL = 2;
