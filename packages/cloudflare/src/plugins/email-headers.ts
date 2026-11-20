/**
 * What a message may put in a header, checked the same way wherever EmDash's
 * Cloudflare mail is sent from: the tenant Worker's email provider
 * (cloudflare-email.ts) and the auth-mail mediator (../auth-mail). No imports,
 * so the mediator's Worker carries it without EmDash.
 */

/** A subject longer than this is cut: Email Sending refuses a header value over 2,048 bytes. */
export const MAX_SUBJECT = 250;
/** A display name longer than this is cut (RFC 5322's recommended line length). */
const MAX_NAME = 78;

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators: none belongs in a header. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const WHITESPACE_RUN = /\s+/g;
/** A display name keeps no quote, angle bracket or backslash, so it cannot read as an address. */
const NAME_SPECIALS = /["<>\\]/g;
/**
 * `value` as one plain address, or null when it is anything else.
 *
 * One address is the WHATWG HTML "valid email address" (`<input type=email>`)
 * with at least one dot in the domain, and at most 254 characters, the longest
 * SMTP carries (RFC 5321, 4.5.3.1). Its local part has no whitespace, comma,
 * semicolon, angle bracket, quote or control character, so it cannot carry a
 * second address or a header break.
 *
 * The pattern is function-local, like `defineNativePlugin`'s: `createPlugin`
 * validates the sender with it while the generated plugins module
 * instantiates plugins, which can run during a circular module init, before a
 * module-scope const is initialized.
 */
export function mailbox(value: unknown): string | null {
	const pattern =
		// oxlint-disable-next-line e18e/prefer-static-regex -- avoids circular-init TDZ
		/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
	if (typeof value !== "string") return null;
	const v = value.trim();
	return v.length <= 254 && pattern.test(v) ? v : null;
}

/** The domain of one plain address, which a log names in place of the address. */
export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * `value` as header text: controls become spaces, whitespace runs one space,
 * cut to `max` characters (whole graphemes, so an emoji is never split).
 */
export function headerText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const flat = value.replace(CONTROLS, " ").replace(WHITESPACE_RUN, " ").trim();
	return Array.from(new Intl.Segmenter().segment(flat), (g) => g.segment)
		.slice(0, max)
		.join("")
		.trim();
}

/** A sender's display name, or undefined when nothing printable is left. */
export function displayName(value: unknown): string | undefined {
	return (
		headerText(typeof value === "string" ? value.replace(NAME_SPECIALS, "") : "", MAX_NAME) ||
		undefined
	);
}
