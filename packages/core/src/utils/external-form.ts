/**
 * The hosts a carried payment form (an `externalForm` block, the importer's
 * external-form.ts in gutenberg-to-portable-text) may post to. The renderer
 * draws a form only when its action is https on one of these, whatever the
 * stored content says. Kept equal to the importer's list by a test.
 */
export const EXTERNAL_FORM_HOSTS: readonly string[] = [
	"www.paypal.com",
	"paypal.com",
	"www.sandbox.paypal.com",
];

/** What a browser folds or drops in a URL: an action holding one is refused, not read. */
const UNSAFE_URL_CHAR = /[\\\s\p{Cc}]/u;

/**
 * The action as the URL a browser posts to, when it is https on an allowed host
 * (https's own port, and no user name or password); otherwise undefined.
 */
export function externalFormAction(action: unknown): URL | undefined {
	const raw = typeof action === "string" ? action.trim() : "";
	if (UNSAFE_URL_CHAR.test(raw) || !URL.canParse(raw)) return undefined;
	const url = new URL(raw);
	return url.protocol === "https:" &&
		EXTERNAL_FORM_HOSTS.includes(url.hostname) &&
		url.port === "" &&
		!url.username &&
		!url.password
		? url
		: undefined;
}

/** An https URL, or undefined. */
export function httpsSrc(src: unknown): string | undefined {
	const raw = typeof src === "string" ? src.trim() : "";
	if (!URL.canParse(raw)) return undefined;
	const url = new URL(raw);
	return url.protocol === "https:" ? url.href : undefined;
}
