/**
 * Email addresses out of what is logged.
 *
 * Runtime logs (Workers Logs among them) keep what is logged, and a message's
 * recipient is whoever a form, a comment or a sign-in named. So text on its way
 * to a log line has every address in it replaced by `<an address at DOMAIN>`:
 * first each address the caller names (a message's recipients and reply-to), in
 * any letter case and URL-encoded as well, then anything else that has the
 * shape of an address, a quoted local part included. An error is redacted
 * whole: its message, its stack (which repeats the message), its own string
 * properties, and each of its causes.
 *
 * The email pipeline, the forms plugin and the Cloudflare Email Sending
 * provider all redact through here, so none of them keeps an address another
 * would remove.
 */

/** How many causes deep an error is followed. */
const MAX_CAUSES = 5;
/** The characters of an unquoted local part (RFC 5322 atext, and the dot). */
const LOCAL_CHAR = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;
/** The characters of a domain name. */
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
const DOMAIN_START = /^[A-Za-z0-9]/;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;
/** The longest quoted local part looked for (RFC 5321 allows 64 octets; escapes double that). */
const MAX_QUOTED = 130;

const stand = (domain: string) => `<an address at ${domain}>`;
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** Every address-shaped run in `text` replaced by its domain. One pass over the text. */
function redactShapes(text: string): string {
	let out = "";
	let done = 0;
	let at = text.indexOf("@");
	while (at !== -1) {
		let start = at;
		if (text[at - 1] === '"') {
			// A quoted local part: back to the quote that opens it.
			let i = at - 2;
			while (i >= done && at - i <= MAX_QUOTED && !(text[i] === '"' && text[i - 1] !== "\\")) i--;
			if (i >= done && text[i] === '"') start = i;
		} else {
			while (start > done && LOCAL_CHAR.test(text[start - 1] ?? "")) start--;
		}
		let end = at + 1;
		while (end < text.length && DOMAIN_CHAR.test(text[end] ?? "")) end++;
		while (end > at + 1 && (text[end - 1] === "." || text[end - 1] === "-")) end--;
		const domain = text.slice(at + 1, end);
		if (start < at && domain.includes(".") && DOMAIN_START.test(domain)) {
			out += text.slice(done, start) + stand(domain);
			done = end;
			at = text.indexOf("@", end);
		} else {
			at = text.indexOf("@", at + 1);
		}
	}
	return out + text.slice(done);
}

/**
 * `text` with each of `known` (in any letter case, and URL-encoded) replaced
 * by `<an address at DOMAIN>`, and then every other address-shaped run too.
 */
export function redactAddresses(text: string, known: readonly string[] = []): string {
	let out = text;
	for (const address of new Set(known.filter((a) => typeof a === "string" && a.includes("@")))) {
		for (const form of new Set([address, encodeURIComponent(address)])) {
			out = out.replace(
				new RegExp(form.replace(REGEXP_SPECIAL, "\\$&"), "gi"),
				stand(domainOf(address)),
			);
		}
	}
	return redactShapes(out);
}

/** The value as a log line would print it, before redaction. */
function told(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return String(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * An error as one log line, redacted: `Name: message`, then each cause as
 * ` [cause: Name: message]`, at most five deep. Any thrown value serves.
 */
export function describeRedacted(error: unknown, known: readonly string[] = []): string {
	let text = told(error);
	let cause = error instanceof Error ? error.cause : undefined;
	for (let depth = 0; cause !== undefined && depth < MAX_CAUSES; depth++) {
		text += ` [cause: ${told(cause)}]`;
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return redactAddresses(text, known);
}

/** Redact one error's own text in place; false when some of it would not take the change. */
function rewrite(error: Error, known: readonly string[]): boolean {
	const clean = (v: string) => redactAddresses(v, known);
	try {
		for (const key of ["message", "stack", ...Object.keys(error)]) {
			const v: unknown = Reflect.get(error, key);
			if (typeof v === "string" && clean(v) !== v && !Reflect.set(error, key, clean(v)))
				return false;
		}
	} catch {
		return false;
	}
	return (
		clean(error.message) === error.message &&
		(typeof error.stack !== "string" || clean(error.stack) === error.stack)
	);
}

/** A fresh error that says what `error` said, redacted, keeping its name and code. */
function replacement(error: unknown, known: readonly string[]): Error {
	const fresh = new Error(describeRedacted(error, known));
	if (error instanceof Error) {
		fresh.name = error.name;
		const code: unknown = Reflect.get(error, "code");
		if (typeof code === "string" || typeof code === "number") Object.assign(fresh, { code });
	}
	return fresh;
}

/**
 * An error whose message, stack, own string properties and causes (five deep)
 * carry no address: `error` itself, redacted in place (so its identity, name
 * and code survive for whoever catches it), or, when it is not an Error or
 * will not take the change, a new Error that says the same, redacted. Throw
 * and log what this returns.
 */
export function scrubAddresses(error: unknown, known: readonly string[] = []): Error {
	if (!(error instanceof Error) || !rewrite(error, known)) return replacement(error, known);
	let parent: Error = error;
	for (let depth = 0; depth < MAX_CAUSES && parent.cause !== undefined; depth++) {
		const cause: unknown = parent.cause;
		if (cause instanceof Error && rewrite(cause, known)) {
			parent = cause;
			continue;
		}
		try {
			parent.cause =
				typeof cause === "string" ? redactAddresses(cause, known) : replacement(cause, known);
		} catch {
			// A cause that cannot be replaced cannot be kept either.
			try {
				delete parent.cause;
			} catch {
				return replacement(error, known);
			}
		}
		break;
	}
	return error;
}
