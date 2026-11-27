// ITEM 164d: the site's own search page is an allowed form action, and nothing else relative is.
//
// WHY THIS FILE EXISTS. `newsletterActionOf` builds `new URL(action)`, which THROWS without a base for a relative action — so a carried
// WordPress search box (`<form method="get" action="/search">`) fell to null and the exclusiveFilter dropped the form WHOLE, with its
// input. A search box rewritten to our own page could therefore never work, and no arm covered the gate at all: the newsletter allowlist
// had none either. These arms pin both halves: the one relative action we accept, and the refusal of every other.
import { describe, expect, it } from "vitest";

import { SEARCH_ACTION_PATHS, sanitizeContent } from "../../../src/utils/sanitize.ts";

const SEARCH_BOX = `<form method="get" action="/search"><label for="q">Search</label><input id="q" type="text" name="q"><button type="submit">Go</button></form>`;

describe("164d: a form posting to our own search page survives the sanitizer", () => {
	it("keeps /search, its input and its button", () => {
		const out = sanitizeContent(SEARCH_BOX);
		expect(out).toContain('action="/search"');
		expect(out).toContain('name="q"');
		// The control is not unwrapped: a search box with no input is not a search box.
		expect(out).not.toContain("embark-unwrapped-control");
	});

	it("accepts the path in any case, since a browser's action is case-insensitive", () => {
		expect(SEARCH_ACTION_PATHS.has("/search")).toBe(true);
		expect(sanitizeContent(SEARCH_BOX.replace('action="/search"', 'action="/Search"'))).toContain('action="/Search"');
	});

	it("REFUSES every other relative action — only /search is ours", () => {
		for (const action of ["/contact", "/", "/search/advanced", "search", "/SEARCH?x=1"]) {
			const out = sanitizeContent(SEARCH_BOX.replace('action="/search"', `action="${action}"`));
			// The form itself is dropped whole, so neither its action nor its input survives.
			expect(out).not.toContain(`action="${action}"`);
			expect(out).not.toContain('name="q"');
		}
	});

	it("still refuses a search form carrying a script attribute, even at /search", () => {
		const out = sanitizeContent(SEARCH_BOX.replace("<form ", '<form onsubmit="steal()" '));
		expect(out).not.toContain('name="q"');
	});

	it("still accepts an absolute allowlisted newsletter action, so this change did not widen the gate", () => {
		const mailchimp = `<form action="https://calulti.us20.list-manage.com/subscribe/post?u=a&amp;id=b" method="post"><input type="email" name="EMAIL"><button type="submit">Subscribe</button></form>`;
		const out = sanitizeContent(mailchimp);
		expect(out).toContain("list-manage.com");
		expect(out).toContain('name="EMAIL"');
	});
});
