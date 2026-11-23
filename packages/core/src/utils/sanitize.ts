import sanitizeHtml from "sanitize-html";

import { canonicalIframeHosts, isPlatformChrome } from "./iframe-hosts.js";

/**
 * Iframe hosts allowed out of the box.
 *
 * Everything else used to be stripped with no way to change it, which meant a
 * site that embedded Google Maps, Calendly, SoundCloud, Spotify, Wistia,
 * Typeform, `youtube-nocookie.com` or even `youtu.be` lost those blocks at
 * render time — silently, with the block still present in the database and
 * still looking correct in the editor.
 */
export const DEFAULT_ALLOWED_IFRAME_HOSTNAMES = ["www.youtube.com", "player.vimeo.com"] as const;

const DEFAULT_HOSTS: ReadonlySet<string> = new Set(DEFAULT_ALLOWED_IFRAME_HOSTNAMES);

let configuredHostnames: string[] = [];

/**
 * Add iframe hosts the renderer must not strip.
 *
 * Additive on purpose — the defaults cannot be removed by configuration, so a
 * misconfigured site can never end up allowing LESS than it did before. Call
 * this from an integration or a plugin's setup hook.
 */
export function configureIframeHostnames(hostnames: Iterable<string>): void {
	configuredHostnames = [
		...new Set([...configuredHostnames, ...canonicalIframeHosts([...hostnames])]),
	];
}

/** Test seam: forget everything `configureIframeHostnames` was given. */
export function resetIframeHostnames(): void {
	configuredHostnames = [];
}

function addedHostnames(): string[] {
	const fromEnv =
		typeof process !== "undefined" && typeof process.env?.EMDASH_IFRAME_HOSTNAMES === "string"
			? canonicalIframeHosts(process.env.EMDASH_IFRAME_HOSTNAMES.split(","))
			: [];
	return [...fromEnv, ...configuredHostnames];
}

/**
 * The effective allowlist: the defaults, plus `EMDASH_IFRAME_HOSTNAMES`
 * (comma-separated), plus anything registered through
 * `configureIframeHostnames`.
 *
 * The environment variable is read on every call rather than cached, so a host
 * that runs one build for many sites can vary it per process.
 */
export function getAllowedIframeHostnames(): string[] {
	return [...new Set([...DEFAULT_ALLOWED_IFRAME_HOSTNAMES, ...addedHostnames()])];
}

/**
 * How the browser reads an iframe src, read strictly, and the one reading
 * every iframe decision here is made on.
 *
 * The raw value, trimmed as the browser trims it, is refused outright when it
 * holds a backslash, whitespace or a control character. A browser folds those
 * (in an https URL a backslash is a slash, and a tab or newline is dropped),
 * and sanitize-html's own check reads a protocol-relative src against a
 * non-special `relative:` base, where `//evil.example\@www.youtube.com/x`
 * names www.youtube.com while the browser loads evil.example. What is left is
 * parsed as an absolute URL, or as https when it is protocol-relative; a
 * path-relative src is refused (no host to allow).
 */
const UNSAFE_SRC_CHAR = /[\\\s\p{Cc}]/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINK_TEXT_MAX = 200;

interface IframeSrc {
	url: URL;
	protocolRelative: boolean;
}

function readIframeSrc(src: string): IframeSrc | undefined {
	const raw = src.trim();
	if (UNSAFE_SRC_CHAR.test(raw)) return undefined;
	const protocolRelative = raw.startsWith("//");
	const absolute = protocolRelative ? `https:${raw}` : raw;
	if (!SCHEME.test(absolute) || !URL.canParse(absolute)) return undefined;
	const url = new URL(absolute);
	return url.protocol === "https:" || url.protocol === "http:"
		? { url, protocolRelative }
		: undefined;
}

/**
 * What becomes of one iframe src, from that one reading: kept as an iframe of
 * `url` (YouTube and Vimeo as before; an added host only over https, never
 * protocol-relative), drawn as a link to `url`, or removed (no reading, or
 * WordPress.com platform chrome, which is no embed and links nowhere useful). Both
 * gates ask this: the transform that draws the iframe or the link, and the
 * filter that re-reads the src it drew.
 */
type IframeVerdict = { keep: boolean; url: URL } | undefined;

function iframeVerdict(src: string, added: ReadonlySet<string>): IframeVerdict {
	const read = readIframeSrc(src);
	if (!read || isPlatformChrome(read.url)) return undefined;
	const { url, protocolRelative } = read;
	const keep =
		DEFAULT_HOSTS.has(url.hostname) ||
		(added.has(url.hostname) && url.protocol === "https:" && !protocolRelative);
	return { keep, url };
}

const warnedHostnames = new Set<string>();

/**
 * Say something the first time a host is refused, once per host per process,
 * so "the map turned into a link" is a one-line fix.
 */
function warnRefused(hostname: string, allowed: readonly string[]): void {
	if (warnedHostnames.has(hostname)) return;
	warnedHostnames.add(hostname);
	console.warn(
		`[emdash] An iframe from "${hostname}" is drawn as a link: it is not in the allowed iframe ` +
			`hostnames (${allowed.join(", ")}), or it is but its src is not https. Add it to the site's ` +
			`iframeHosts setting, EMDASH_IFRAME_HOSTNAMES or configureIframeHostnames().`,
	);
}

export interface SanitizeOptions {
	/**
	 * More iframe hosts for this call, such as the site's `iframeHosts`
	 * setting. Added to the defaults, `EMDASH_IFRAME_HOSTNAMES` and
	 * `configureIframeHostnames()`, never in place of them. Entries that do not
	 * name exactly one host are ignored.
	 */
	allowedIframeHostnames?: readonly string[];
	/**
	 * The newsletter providers whose forms are carried WORKING, such as the
	 * site's `newsletterFormHosts` setting. Omitted: the default list.
	 *
	 * A Mailchimp embed is a plain HTML form POST to
	 * `https://<dc>.list-manage.com/subscribe/post?u=…&id=…` — no script, so it
	 * works from any origin. The owner's standing rule is that every source
	 * control gets a working equivalent, and a customer's sign-up list is the
	 * customer's: routing it into EmDash's own subscriptions would take their
	 * sign-ups off the audience they already mail from.
	 */
	newsletterFormHosts?: readonly string[];
}

/** The tags that are a form control, and so are gated on their form's action. */
const CONTROL_TAGS = new Set(["input", "select", "option", "textarea", "button", "label"]);

/** The newsletter providers whose forms are carried working, out of the box. */
export const DEFAULT_NEWSLETTER_FORM_HOSTS: readonly string[] = ["list-manage.com"];

/** Whether `host` is one of `allowed`, or a subdomain of one. */
function newsletterHostAllowed(host: string, allowed: readonly string[]): boolean {
	const h = host.toLowerCase();
	return allowed.some((a) => {
		const want = a.toLowerCase().replace(/^\*?\./, "");
		return h === want || h.endsWith(`.${want}`);
	});
}

/**
 * The form's action, when it is an https POST to an allowlisted newsletter
 * host; null otherwise.
 *
 * FAIL CLOSED on everything else: a `javascript:` action, a non-https scheme,
 * a host not on the list, or a script handler on the form. The controls are
 * only ever carried inside a form whose action this function approved.
 */
function newsletterActionOf(
	attribs: Record<string, string>,
	allowed: readonly string[],
): string | null {
	const action = (attribs.action ?? "").trim();
	if (action.length === 0) return null;
	let url: URL;
	try {
		url = new URL(action);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (!newsletterHostAllowed(url.hostname, allowed)) return null;
	for (const attr of ["onsubmit", "onload", "onerror", "onclick"]) {
		if (attribs[attr] !== undefined) return null;
	}
	return url.href;
}

/**
 * Sanitize HTML content to prevent XSS attacks.
 *
 * Allows standard formatting tags, images, iframes (from allowed providers),
 * and basic attributes.
 *
 * An iframe is kept when its host is YouTube's or Vimeo's (as before), or an
 * added host and its src is https (not protocol-relative); a kept iframe's src
 * is drawn as the URL the decision read. Any other iframe with an http(s) or
 * protocol-relative src is drawn as a link to that src, titled with the
 * iframe's title or "Open the embedded content" and the host, so a refused map
 * is a link, never an empty box. An iframe with no usable src (none,
 * path-relative, another scheme such as `javascript:`, or one holding a
 * backslash, whitespace or a control character) is removed, and so is
 * WordPress.com platform chrome (a Jetpack Likes button), whatever the lists say.
 *
 * A `<noscript>` goes whole, with everything in it, as a `<script>` or a
 * `<style>` does: the browser draws what it holds only with scripts off, and
 * the page runs scripts. Unwrapped (sanitize-html's default for a tag it does
 * not allow), a pasted embed's "turn on JavaScript" line was drawn as text,
 * and a tracking pixel's `<img>` loaded on every page view.
 */
export function sanitizeContent(html: string, options: SanitizeOptions = {}): string {
	const perCall = canonicalIframeHosts(options.allowedIframeHostnames);
	const added = new Set([...addedHostnames(), ...perCall].filter((h) => !DEFAULT_HOSTS.has(h)));
	const allowed = [...DEFAULT_HOSTS, ...added];
	const newsletterHosts = options.newsletterFormHosts ?? DEFAULT_NEWSLETTER_FORM_HOSTS;
	// One entry per open <form>: whether its action is an allowlisted newsletter
	// host. onOpenTag/onCloseTag run before the transforms and see the raw
	// attributes, so a control's transform reads the form it actually sits in.
	const forms: boolean[] = [];
	const insideNewsletterForm = () => forms.length > 0 && forms[forms.length - 1] === true;
	// A CONTROL OUTSIDE AN APPROVED FORM gets exactly what it got before forms
	// were carried: a textarea or an option goes whole with its text (they were
	// nonTextTags), and an input, button, label or select is unwrapped to its
	// text, because a name sanitize-html does not allow is discarded that way.
	const DROP_WHOLE = new Set(["textarea", "option"]);
	const control = (tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
		if (insideNewsletterForm()) return { tagName, attribs };
		if (DROP_WHOLE.has(tagName)) return { tagName, attribs: { "data-embark-drop": "1" } };
		return { tagName: "embark-unwrapped-control", attribs: {} };
	};
	const controlTransforms = Object.fromEntries(Array.from(CONTROL_TAGS, (t) => [t, control]));
	return sanitizeHtml(html, {
		onOpenTag: (name, attribs) => {
			if (name === "form") forms.push(newsletterActionOf(attribs, newsletterHosts) !== null);
		},
		onCloseTag: (name) => {
			if (name === "form") forms.pop();
		},
		// A NEWSLETTER FORM'S CONTROLS ARE ALLOWED HERE, and gated below: the
		// exclusiveFilter drops every one of them unless it sits inside a form
		// whose action is an allowlisted newsletter host. Allowing the tag and
		// gating the instance is what lets the same sanitizer carry a working
		// Mailchimp form and still refuse every other form's controls.
		allowedTags: [
			...sanitizeHtml.defaults.allowedTags,
			"img",
			"span",
			"iframe",
			"form",
			"input",
			"select",
			"option",
			"textarea",
			"button",
			"label",
		],
		nonTextTags: ["script", "style", "noscript"],
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			"*": ["class", "id", "data-*"],
			iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen", "title"],
			img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
			form: ["action", "method", "target", "rel", "class", "id", "name", "novalidate"],
			input: [
				"type",
				"name",
				"value",
				"id",
				"class",
				"placeholder",
				"required",
				"checked",
				"maxlength",
				"size",
				"autocomplete",
				"aria-label",
				"aria-required",
			],
			select: ["name", "id", "class", "required", "aria-label", "aria-required"],
			option: ["value", "selected", "label"],
			textarea: ["name", "id", "class", "rows", "cols", "placeholder", "required", "aria-label"],
			button: ["type", "name", "value", "id", "class", "aria-label"],
			label: ["for", "class", "id"],
		},
		allowedIframeHostnames: allowed,
		transformTags: {
			...controlTransforms,
			// A NEWSLETTER FORM IS CARRIED WORKING. The action is approved here,
			// and the marker is what the exclusiveFilter reads to keep the form
			// and its controls; every other form is dropped whole.
			form: (tagName, attribs): sanitizeHtml.Tag => {
				const action = newsletterActionOf(attribs, newsletterHosts);
				if (!action) return { tagName, attribs: {} };
				return {
					tagName,
					attribs: {
						action,
						method: "post",
						target: "_blank",
						rel: "noopener",
						...(attribs.class ? { class: attribs.class } : {}),
						"data-embark-newsletter": "1",
					},
				};
			},
			iframe: (tagName, attribs): sanitizeHtml.Tag => {
				const verdict = iframeVerdict(attribs.src ?? "", added);
				if (!verdict) return { tagName, attribs: {} };
				// The src drawn is the URL decided on, so the browser loads what was checked.
				if (verdict.keep) return { tagName, attribs: { ...attribs, src: verdict.url.href } };
				const host = verdict.url.hostname;
				warnRefused(host, allowed);
				const title = (attribs.title ?? "").trim().slice(0, LINK_TEXT_MAX);
				return {
					tagName: "a",
					attribs: { href: verdict.url.href, class: "emdash-iframe-link" },
					text: title || `Open the embedded content (${host})`,
				};
			},
		},
		// The second gate: an iframe still standing is re-read from the src it
		// drew, with the same reading, and goes whole (never an empty box) unless
		// that src is kept. sanitize-html's own host check stays as a third.
		exclusiveFilter: (frame) => {
			if (
				frame.tag === "iframe" &&
				frame.attribs.href === undefined &&
				iframeVerdict(frame.attribs.src ?? "", added)?.keep !== true
			) {
				return true;
			}
			// A FORM ITSELF SURVIVES ONLY WHEN ITS ACTION IS ALLOWLISTED. The
			// transform below marks the ones that are, and this drops the rest
			// whole — with their controls, which is what every other form got
			// before this change.
			if (frame.tag === "form") return frame.attribs["data-embark-newsletter"] !== "1";
			if (frame.attribs["data-embark-drop"] === "1") return true;
			return false;
		},
	});
}
