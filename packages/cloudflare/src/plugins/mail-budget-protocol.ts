/**
 * The version of the mail-budget service's RPC that EmDash's Cloudflare mail
 * speaks: the tenant Worker's email provider (cloudflare-email.ts) and the
 * auth-mail mediator (../auth-mail) both name it in every request, and an
 * answer that does not name the same one is a refusal, so a service that
 * changed what a take or a refusal means is never read as the one they know.
 *
 * 2: the reserve kept for sign-in mail is a LANE the token is registered to,
 * never a flag a request carries (1 sent `system: true` for "system" mail,
 * which anything in the tenant's Worker could send too). No imports, so the
 * mediator's Worker carries it without EmDash.
 */
export const MAIL_BUDGET_PROTOCOL = 2;
