/**
 * The version of the mail-budget service's RPC that EmDash's Cloudflare mail
 * speaks: the site's mail broker (../auth-mail/broker.ts), the only caller,
 * names it in every request, and an answer that does not name the same one is
 * a refusal, so a service that changed what a take or a refusal means is
 * never read as the one it knows.
 *
 * 2: the reserve kept for sign-in mail is a LANE the token is registered to,
 * never a flag a request carries (1 sent `system: true` for "system" mail,
 * which anything in the tenant's Worker could send too). 3: a token belongs to
 * a GENERATION that must be active for a take, a take names its request id (a
 * retry with the same id is the same take), a take answers its generation and
 * a report its generation and state. No imports, so the broker's Worker
 * carries it without EmDash.
 */
export const MAIL_BUDGET_PROTOCOL = 3;
