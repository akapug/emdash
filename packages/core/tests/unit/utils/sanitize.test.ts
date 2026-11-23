import { afterEach, describe, expect, it, vi } from "vitest";

import {
	configureIframeHostnames,
	getAllowedIframeHostnames,
	resetIframeHostnames,
	sanitizeContent,
} from "../../../src/utils/sanitize.js";

// An HTML block (a custom HTML block, a block the converter does not know) is
// drawn through sanitizeContent. What the browser never draws on a page that
// runs scripts, it draws nothing of.
describe("sanitizeContent: what a page that runs scripts never draws", () => {
	it("draws nothing of a stylesheet, a script or a scripts-off fallback", () => {
		expect(
			sanitizeContent(
				`<style>.x{color:red}</style><p>Before.</p><script>track()</script><noscript>Turn on JavaScript to see the form.</noscript><p>After.</p>`,
			),
		).toBe("<p>Before.</p><p>After.</p>");
	});

	it("loads no image a scripts-off fallback holds, and keeps what follows it", () => {
		expect(
			sanitizeContent(
				`<div><noscript><img height="1" width="1" src="https://example.org/pixel.gif?id=1" /><noscript>inner</noscript></noscript>Seen.</div>`,
			),
		).toBe("<div>Seen.</div>");
	});
});

// An imported Google Map, form or booking widget is an iframe. YouTube and
// Vimeo are always allowed; a site adds its own hosts (its iframeHosts
// setting, EMDASH_IFRAME_HOSTNAMES, configureIframeHostnames), and an added
// host is kept only with an https src. A refused iframe is a link to its src,
// never an empty box.
describe("sanitizeContent: iframe hosts", () => {
	const map = (src: string, extra = "") =>
		`<iframe src="${src}" width="600" height="450"${extra}></iframe>`;
	const mapsUrl = "https://www.google.com/maps/embed?pb=1";

	afterEach(() => {
		resetIframeHostnames();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("keeps an iframe from a host the site added, when its src is https", () => {
		expect(
			sanitizeContent(map(mapsUrl, ` title="Our office"`), {
				allowedIframeHostnames: ["www.google.com"],
			}),
		).toBe(
			`<iframe src="https://www.google.com/maps/embed?pb=1" width="600" height="450" title="Our office"></iframe>`,
		);
	});

	it("keeps YouTube and Vimeo whatever the site's list holds", () => {
		const youtube = map("https://www.youtube.com/embed/abcdefghijk");
		const vimeo = map("https://player.vimeo.com/video/1");
		for (const allowedIframeHostnames of [[], ["www.google.com"], ["-www.youtube.com"]]) {
			expect(sanitizeContent(youtube, { allowedIframeHostnames })).toBe(youtube);
			expect(sanitizeContent(vimeo, { allowedIframeHostnames })).toBe(vimeo);
		}
		// as before: a protocol-relative or http src from a default host is kept,
		// a protocol-relative one drawn as the https URL it was read as
		expect(sanitizeContent(map("//www.youtube.com/embed/abcdefghijk"))).toContain(
			`<iframe src="https://www.youtube.com/embed/abcdefghijk"`,
		);
		expect(sanitizeContent(map("http://player.vimeo.com/video/1"))).toContain(
			`<iframe src="http://player.vimeo.com/video/1"`,
		);
	});

	it("draws an added host's http or protocol-relative iframe as a link, never the iframe", () => {
		const opts = { allowedIframeHostnames: ["www.google.com"] };
		expect(sanitizeContent(map("http://www.google.com/maps/embed?pb=1"), opts)).toBe(
			`<a href="http://www.google.com/maps/embed?pb=1" class="emdash-iframe-link">Open the embedded content (www.google.com)</a>`,
		);
		expect(sanitizeContent(map("//www.google.com/maps/embed?pb=1"), opts)).toBe(
			`<a href="https://www.google.com/maps/embed?pb=1" class="emdash-iframe-link">Open the embedded content (www.google.com)</a>`,
		);
	});

	it("ignores list entries that do not name exactly one host", () => {
		const malformed = [
			"*.google.com",
			".google.com",
			"https://www.google.com",
			"www.google.com:443",
			"www.google.com/maps",
			"user@www.google.com",
			"www.google.com.",
			"google",
			"1.2.3.4",
			"localhost",
			"",
			42,
			null,
			{ host: "www.google.com" },
		] as unknown as string[];
		const html = sanitizeContent(map(mapsUrl), { allowedIframeHostnames: malformed });
		expect(html).not.toContain("<iframe");
		expect(html).toContain(`class="emdash-iframe-link"`);
		// a value that is not a list at all is no list
		const notAList = "www.google.com" as unknown as string[];
		expect(sanitizeContent(map(mapsUrl), { allowedIframeHostnames: notAList })).not.toContain(
			"<iframe",
		);
	});

	it("never allows a host under a shared platform domain or our own", () => {
		for (const host of ["acme.workers.dev", "acme.pages.dev", "acme.embarkeasy.com"]) {
			const html = sanitizeContent(map(`https://${host}/embed`), {
				allowedIframeHostnames: [host],
			});
			expect(html, host).not.toContain("<iframe");
			expect(html, host).toContain(`(${host})</a>`);
		}
	});

	it("draws a refused iframe as a link to its src, titled by the iframe or by its host", () => {
		expect(sanitizeContent(map("https://calendly.com/acme/30min"))).toBe(
			`<a href="https://calendly.com/acme/30min" class="emdash-iframe-link">Open the embedded content (calendly.com)</a>`,
		);
		expect(
			sanitizeContent(
				map("https://calendly.com/acme/30min", ` title="Book a &quot;call&quot; <now>"`),
			),
		).toBe(
			`<a href="https://calendly.com/acme/30min" class="emdash-iframe-link">Book a "call" &lt;now&gt;</a>`,
		);
		// what the iframe held instead of the page goes with it
		expect(
			sanitizeContent(`<iframe src="https://calendly.com/x">Your browser has no frames</iframe>`),
		).toBe(
			`<a href="https://calendly.com/x" class="emdash-iframe-link">Open the embedded content (calendly.com)</a>`,
		);
	});

	it("removes an iframe with no usable src instead of drawing an empty box", () => {
		for (const src of [
			"javascript:alert(1)",
			" JaVaScRiPt:alert(1)",
			"javascript://www.youtube.com/%0Aalert(1)",
			"data:text/html,<script>alert(1)</script>",
			"/embed/local",
			"relative://relative-site/x",
			"",
			// a browser folds a backslash, a tab or a newline; such a src is never read
			"//evil.example\\@www.youtube.com/x",
			"https://evil.example\\@www.youtube.com/x",
			"https:\\\\evil.example\\@www.google.com/maps",
			"https://www.you\ttube.com/embed/abcdefghijk",
			"https://www.youtube.com\n.evil.example/x",
			"//www.youtube.com\u0000.evil.example/x",
		]) {
			expect(sanitizeContent(`<p>a</p>${map(src)}<p>b</p>`), src).toBe("<p>a</p><p>b</p>");
		}
		expect(sanitizeContent(`<p>a</p><iframe width="600"></iframe><p>b</p>`)).toBe(
			"<p>a</p><p>b</p>",
		);
	});

	it("never draws an iframe of evil.example from //evil.example\\@www.youtube.com/x", () => {
		// sanitize-html reads this src against a non-special base and finds
		// www.youtube.com; an https page's browser loads evil.example
		const html = sanitizeContent(`<p>a</p>${map("//evil.example\\@www.youtube.com/x")}<p>b</p>`);
		expect(html).toBe("<p>a</p><p>b</p>");
		expect(html).not.toContain("evil.example");
	});

	it("hands sanitize-html the canonical URL it decided on, so both gates read one string", () => {
		expect(sanitizeContent(map("HTTPS://WWW.YOUTUBE.COM/embed/abcdefghijk"))).toContain(
			`<iframe src="https://www.youtube.com/embed/abcdefghijk"`,
		);
		expect(
			sanitizeContent(map(" https://www.google.com/maps/embed?pb=1&amp;z=2 "), {
				allowedIframeHostnames: ["www.google.com"],
			}),
		).toContain(`<iframe src="https://www.google.com/maps/embed?pb=1&amp;z=2"`);
	});

	it("matches a domain only at a dot, so evilembarkeasy.com is no embarkeasy.com host", () => {
		expect(
			sanitizeContent(map("https://evilembarkeasy.com/x"), {
				allowedIframeHostnames: ["evilembarkeasy.com"],
			}),
		).toContain(`<iframe src="https://evilembarkeasy.com/x"`);
	});

	it("reads the host the browser reads, so a lookalike src is a link to the real host", () => {
		const opts = { allowedIframeHostnames: ["www.google.com"] };
		for (const [src, host] of [
			["https://www.google.com.evil.example/maps", "www.google.com.evil.example"],
			["https://www.google.com@evil.example/maps", "evil.example"],
			["//www.google.com.evil.example/maps", "www.google.com.evil.example"],
			["//evil.example/@www.youtube.com/x", "evil.example"],
			["https://evil.example/?u=https://www.google.com/", "evil.example"],
		] as const) {
			const html = sanitizeContent(map(src), opts);
			expect(html, src).not.toContain("<iframe");
			expect(html, src).toContain(`(${host})</a>`);
		}
	});

	it("never passes srcdoc or an event handler through", () => {
		const html = sanitizeContent(
			`<iframe src="${mapsUrl}" srcdoc="<script>alert(1)</script>" onload="alert(1)"></iframe>`,
			{ allowedIframeHostnames: ["www.google.com"] },
		);
		expect(html).toBe(`<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>`);
	});

	it("adds EMDASH_IFRAME_HOSTNAMES and configureIframeHostnames hosts on the same terms", () => {
		vi.stubEnv("EMDASH_IFRAME_HOSTNAMES", " Forms.Example.org , *.bad.example");
		configureIframeHostnames(["maps.example.net"]);
		expect(getAllowedIframeHostnames()).toEqual([
			"www.youtube.com",
			"player.vimeo.com",
			"forms.example.org",
			"maps.example.net",
		]);
		expect(sanitizeContent(map("https://forms.example.org/f"))).toContain("<iframe");
		expect(sanitizeContent(map("https://maps.example.net/m"))).toContain("<iframe");
		expect(sanitizeContent(map("http://maps.example.net/m"))).not.toContain("<iframe");
	});

	it("says once which host it drew as a link", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		sanitizeContent(map("https://once.example.com/a"));
		sanitizeContent(map("https://once.example.com/b"));
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(`"once.example.com"`);
	});
});

// A post copied from a rendered WordPress.com page carries its Jetpack Likes
// button, an iframe from widgets.wp.com/likes/ that works only on WordPress.com.
// Imported before the WordPress import dropped it, or pasted into an HTML
// block, it is neither drawn nor linked, whatever the site's list holds.
describe("sanitizeContent: WordPress.com platform chrome", () => {
	const likes = (src: string) =>
		`<div class="sharedaddy"><iframe class="post-likes-widget" src="${src}" width="100%" height="55px" frameborder="0"></iframe></div>`;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		"https://widgets.wp.com/likes/#blog_id=1&amp;post_id=5&amp;origin=example.wordpress.com",
		"//widgets.wp.com/likes/#blog_id=1",
		"http://widgets.wp.com/likes/master.html?ver=1",
		"https://WIDGETS.WP.COM/likes",
	])("draws nothing of %s, not even a link, and says nothing", (src) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const allowedIframeHostnames of [[], ["widgets.wp.com"]]) {
			expect(sanitizeContent(likes(src), { allowedIframeHostnames })).toBe(
				`<div class="sharedaddy"></div>`,
			);
		}
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		"https://videopress.com/embed/AbCdEfGh",
		"https://video.wordpress.com/embed/AbCdEfGh",
		"https://widgets.wp.com/other/",
		"https://widgets.wp.com.example/likes/",
	])("treats %s as any other host: a link, or the iframe once allowed", (src) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(sanitizeContent(likes(src))).toContain(`class="emdash-iframe-link"`);
		const host = new URL(src).hostname;
		expect(sanitizeContent(likes(src), { allowedIframeHostnames: [host] })).toContain(
			`<iframe class="post-likes-widget" src="${src}"`,
		);
	});
});

// A NEWSLETTER FORM IS CARRIED WORKING (owner's ruling, 2026-11-23).
//
// A Mailchimp embed is a plain HTML form POST to
// https://<dc>.list-manage.com/subscribe/post?u=…&id=… — no script, so it works
// from any origin. The owner's standing rule is that every source control gets
// a working equivalent, and a customer's sign-up list is the customer's:
// routing it into EmDash's own subscriptions would take their sign-ups off the
// audience they already mail from.
//
// MEASURED on calulti.org/subscribe/: 39 inputs, a country select of 234
// options, checkbox groups. The served page showed the labels and ZERO
// controls — "Email Address *" with no box to type in.
const MAILCHIMP = `<div id="mc_embed_signup"><form action="https://calulti.us20.list-manage.com/subscribe/post?u=84962611ecc6d269483b6cd73&amp;id=2bde2" method="post" id="mc-embedded-subscribe-form" class="validate" target="_blank" novalidate>
<div class="mc-field-group"><label for="mce-EMAIL">Email Address </label><input type="email" value="" name="EMAIL" class="required email" id="mce-EMAIL"></div>
<div class="mc-field-group"><label for="mce-FNAME">First Name </label><input type="text" value="" name="FNAME" id="mce-FNAME"></div>
<div class="mc-field-group"><label for="mce-COUNTRY">Country </label><select name="COUNTRY" id="mce-COUNTRY"><option value="">Select</option><option value="US">United States</option><option value="CA">Canada</option></select></div>
<input type="hidden" name="b_84962611ecc6d269483b6cd73_2bde2" value="">
<div class="clear"><input type="submit" value="Subscribe" name="subscribe" id="mc-embedded-subscribe" class="button"></div>
</form></div>`;

describe("a newsletter form is carried WORKING", () => {
	it("THE FORM, ITS FIELDS AND ITS OPTIONS SURVIVE", () => {
		const out = sanitizeContent(MAILCHIMP);
		expect(out, "the form is there").toContain("<form");
		expect(out, "the action is the customer's own list").toContain(
			"list-manage.com/subscribe/post",
		);
		expect(out, "the email field is there").toContain('name="EMAIL"');
		expect(out, "the first name is there").toContain('name="FNAME"');
		expect(out, "the country select is there").toContain("<select");
		expect(out, "its options travel with it").toContain("United States");
		expect(out, "the honeypot is kept").toContain("b_84962611ecc6d269483b6cd73_2bde2");
		expect(out, "the submit is there").toContain('value="Subscribe"');
	});

	it("A NON-ALLOWLISTED ACTION GETS NO CONTROLS", () => {
		const other = MAILCHIMP.replace(
			"https://calulti.us20.list-manage.com/subscribe/post?u=84962611ecc6d269483b6cd73&amp;id=2bde2",
			"https://evil.example.com/collect",
		);
		const out = sanitizeContent(other);
		expect(out, "no form survives").not.toContain("<form");
		expect(out, "no input survives").not.toContain("<input");
		expect(out, "no select survives").not.toContain("<select");
	});

	it("A javascript: ACTION IS REFUSED", () => {
		const js = MAILCHIMP.replace(
			"https://calulti.us20.list-manage.com/subscribe/post?u=84962611ecc6d269483b6cd73&amp;id=2bde2",
			"javascript:alert(1)",
		);
		const out = sanitizeContent(js);
		expect(out, "no form survives").not.toContain("<form");
		expect(out, "no input survives").not.toContain("<input");
	});

	it("A SCRIPT HANDLER ON THE FORM IS REFUSED", () => {
		const handler = MAILCHIMP.replace("novalidate>", 'novalidate onsubmit="steal()">');
		const out = sanitizeContent(handler);
		expect(out, "no form survives").not.toContain("<form");
		expect(out, "no input survives").not.toContain("<input");
	});

	// Allowing the control tags must not carry a control that sits in NO form,
	// or after an approved form has closed: those get what they got before.
	it("A CONTROL OUTSIDE ANY FORM GETS WHAT IT GOT BEFORE", () => {
		const out = sanitizeContent(
			'<p>Name <input name="loose"> <button>Go now</button> <label>A label</label> <textarea>typed secret</textarea> <select><option>An option</option></select></p>',
		);
		for (const tag of [
			"<input",
			"<button",
			"<label",
			"<textarea",
			"<select",
			"<option",
			"embark-unwrapped-control",
			"data-embark-drop",
		]) {
			expect(out, `${tag} does not survive outside a form`).not.toContain(tag);
		}
		expect(out, "a button's text unwraps, as before").toContain("Go now");
		expect(out, "a label's text unwraps, as before").toContain("A label");
		expect(out, "a textarea goes whole, as before").not.toContain("typed secret");
		expect(out, "an option goes whole, as before").not.toContain("An option");
	});

	it("A CONTROL AFTER AN APPROVED FORM CLOSES IS NOT CARRIED", () => {
		const out = sanitizeContent(`${MAILCHIMP}<p><input name="after-the-form"></p>`);
		expect(out, "the approved form's field is still there").toContain('name="EMAIL"');
		expect(out, "the control after it is not").not.toContain("after-the-form");
	});
});
