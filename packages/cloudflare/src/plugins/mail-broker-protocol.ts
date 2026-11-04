/**
 * The version of the site's mail broker's RPC (../auth-mail/broker.ts): what
 * a send, an auth operation and a status ask and answer. The site's email
 * provider (cloudflare-email.ts) and EmDash's own sign-in routes name it in
 * every request, and an answer that does not name it is not the broker's.
 *
 * 3: every sign-in operation names a request id, as a send does, and an answer
 * may be `unknown` (an operation or a send whose first attempt never finished
 * may have gone); 2 carried the site's generation capability in every request;
 * 1 was the auth-mail mediator's, before the site's own mail went through it
 * too. No imports, so the broker's Worker carries it without EmDash.
 */
export const MAIL_BROKER_PROTOCOL = 3;
