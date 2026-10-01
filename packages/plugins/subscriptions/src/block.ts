/**
 * The sign-up block: an `emdash-subscribe` Portable Text block that puts the
 * plugin's form anywhere in a page's content, and what its component draws.
 *
 * The block stores two words and nothing else: `heading`, the sign-up's lead
 * line, and `button`, its button's label. An owner adds one in the editor; an
 * import makes one where the source site had a sign-up box. Either can be
 * left out, and the component says plain words in its place.
 *
 * The form needs no script. It posts the address to the plugin's `subscribe`
 * route, which sends the visitor back to this page with what it did
 * (`?subscribe=`, see SUBSCRIBE_STATUSES), and the block says that above the
 * form: that a confirmation email was sent only when one was.
 */

import { pageOf, ROUTES, SUBSCRIBE_STATUSES, type SubscribeStatus } from "./subscriptions.js";

/** The block's Portable Text type. */
export const SUBSCRIBE_BLOCK = "emdash-subscribe";

/** The block, as content stores it. */
export interface SubscribeBlock {
	_type: typeof SUBSCRIBE_BLOCK;
	_key: string;
	/** The sign-up's lead line, for example "Subscribe to <publication>". */
	heading?: string;
	/** The button's label. */
	button?: string;
}

/** What the block says where it stores no words of its own. */
export const SUBSCRIBE_DEFAULTS = {
	heading: "Get new posts by email",
	button: "Subscribe",
} as const;

/** What the block says after a try. `done`: the visitor is signed up (or confirmed), and the form is not drawn again. */
export interface SubscribeMessage {
	ok: boolean;
	done?: true;
	text: string;
}

/**
 * What the block says after a try, by the plugin's status. Each is true of
 * what the plugin did: where the site cannot send email yet, it says that no
 * confirmation email was sent.
 */
export const SUBSCRIBE_MESSAGES: Record<SubscribeStatus, SubscribeMessage> = {
	sent: {
		ok: true,
		done: true,
		text: "Thank you. A confirmation email was sent to you: click the link in it to start getting new posts.",
	},
	saved: {
		ok: true,
		done: true,
		text: "Thank you, your subscription is saved. This site cannot send email yet, so no confirmation email was sent. It will send you one when it can, and new posts start once you confirm.",
	},
	queued: {
		ok: true,
		done: true,
		text: "Thank you, your subscription is saved. The confirmation email could not be sent just now: the site will try again in a few minutes, and new posts start once you confirm.",
	},
	pending: {
		ok: false,
		text: "You already asked to subscribe with this email address. Please find the confirmation email and click the link in it.",
	},
	pending_saved: {
		ok: false,
		text: "You already asked to subscribe with this email address. This site cannot send email yet: it will send you a confirmation email when it can.",
	},
	already: { ok: false, text: "This email address is already subscribed." },
	invalid_email: {
		ok: false,
		text: "That email address is not valid. Please check it and try again.",
	},
	error: { ok: false, text: "Something went wrong. Please try again." },
	confirmed: {
		ok: true,
		done: true,
		text: "Your subscription is confirmed. Each new post will be emailed to you.",
	},
	unsubscribed: { ok: true, text: "You are unsubscribed. No more posts will be emailed to you." },
	invalid_link: { ok: false, text: "This link is not valid, or it was already used." },
};

/** What the component draws for one block on one page. */
export interface SubscribeView {
	/** The block's element id: the fragment the route sends the visitor back to. */
	id: string;
	heading: string;
	button: string;
	/** Where the form posts. */
	action: string;
	/** The page to come back to: a path, as the route takes it. */
	source: string;
	/** What the visitor's last try did, when the page was reached from one. */
	message: (SubscribeMessage & { status: SubscribeStatus }) | null;
	/** The visitor is signed up: the form is not drawn again. */
	done: boolean;
}

/** What a key keeps in an element id: the characters a fragment the route accepts may hold. */
const NOT_ID = /[^A-Za-z0-9_-]/g;

const words = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const isStatus = (value: string | null): value is SubscribeStatus =>
	(SUBSCRIBE_STATUSES as readonly (string | null)[]).includes(value);

/** A path's trailing slash, which Astro's directory build format adds to `originPathname`. */
const TRAILING_SLASH = /\/+$/;

/**
 * What one block draws. `path` is the page the visitor asked for, decoded
 * (Astro's `originPathname`: before a rewrite, which a migrated site's
 * layout goes through); `status` is the page's `?subscribe=`. The page is
 * written as the site writes its own paths, with no trailing slash.
 */
export function subscribeView(
	node: Partial<SubscribeBlock> | undefined,
	path: string,
	status: string | null,
): SubscribeView {
	const key = typeof node?._key === "string" ? node._key.replace(NOT_ID, "").slice(0, 80) : "";
	const message = isStatus(status) ? { status, ...SUBSCRIBE_MESSAGES[status] } : null;
	return {
		id: key ? `subscribe-${key}` : "subscribe",
		heading: words(node?.heading) ?? SUBSCRIBE_DEFAULTS.heading,
		button: words(node?.button) ?? SUBSCRIBE_DEFAULTS.button,
		action: `${ROUTES}/subscribe`,
		// The route's own check: a path it would not send the visitor back to is the home page.
		source: pageOf(encodeURI(path.replace(TRAILING_SLASH, ""))),
		message,
		done: message?.done === true,
	};
}
