/**
 * A form that posts to a payment provider is carried as the form it is. Read
 * as text, a migrated "Pay with a Credit Card" page told visitors to pick a
 * party size and click "Buy Now", and offered neither.
 */

import { describe, expect, it } from "vitest";

import { externalFormAction, externalFormRefusal, gutenbergToPortableText } from "../src/index.js";
import type { PortableTextBlock, PortableTextExternalFormBlock } from "../src/types.js";

/** Each block as its type and text; a form as its action and what it draws. */
const shape = (blocks: PortableTextBlock[]) =>
	blocks.map((b) => {
		if (b._type === "block")
			return `${b.style}: ${b.children
				.map((c) => c.text)
				.join("")
				.trim()}`;
		if (b._type === "externalForm") return `form ${b.method} ${b.action}`;
		if (b._type === "htmlBlock") return `html ${b.html}`;
		return `[${b._type}]`;
	});
const formOf = (blocks: PortableTextBlock[]) =>
	blocks.find((b): b is PortableTextExternalFormBlock => b._type === "externalForm")!;

/** A PayPal hosted Buy Now button as a classic post saves it (a migrated site's payment page). */
const PAYPAL = `<form action="https://www.paypal.com/cgi-bin/webscr" method="post"><input type="hidden" name="cmd" value="_s-xclick" /> <input type="hidden" name="hosted_button_id" value="6EADFSWU3YGJ6" />
<table class="aligncenter">
<tbody>
<tr>
<td><input type="hidden" name="on0" value="Number of people" />Number of people in your party: price (USD)</td>
</tr>
<tr>
<td><select name="os0"> <option value="1:">1: $50.00</option> <option value="2:">2: $80.00</option> <option value="8:">8: $200.00</option> </select></td>
</tr>
</tbody>
</table>
<input type="hidden" name="currency_code" value="USD" /> <input type="image" name="submit" src="https://www.paypalobjects.com/en_US/i/btn/btn_buynowCC_LG.gif" alt="PayPal - The safer, easier way to pay online!" /> <img src="https://www.paypalobjects.com/en_US/i/scr/pixel.gif" alt="" width="1" height="1" border="0" /></form><form action="https://www.paypal.com/cgi-bin/webscr" method="post"></form><strong>*</strong> <em>Parties larger than 8 pay by phone.</em>`;

describe("a classic post's PayPal form", () => {
	it("is a form posting to PayPal, between the text before and after it", () => {
		const blocks = gutenbergToPortableText(
			`Select your party size and click "Buy Now" below.\n\n${PAYPAL}`,
		);
		expect(shape(blocks)).toEqual([
			"normal: Select your party size and click “Buy Now” below.",
			"form post https://www.paypal.com/cgi-bin/webscr",
			"normal: * Parties larger than 8 pay by phone.",
		]);
	});

	it("keeps its hidden fields, its option's label, its select's choices and its image button, and draws no tracking pixel", () => {
		const form = formOf(gutenbergToPortableText(PAYPAL));
		expect(form.provider).toBe("paypal");
		expect(form.hidden.map((h) => [h.name, h.value])).toEqual([
			["cmd", "_s-xclick"],
			["hosted_button_id", "6EADFSWU3YGJ6"],
			["on0", "Number of people"],
			["currency_code", "USD"],
		]);
		expect(form.items.map((i) => i._type)).toEqual(["text", "select", "submit"]);
		const [label, select, submit] = form.items as [
			{ text: string },
			{ name: string; options: { value: string; label: string }[] },
			{ image: string; label: string; name: string },
		];
		expect(label.text).toBe("Number of people in your party: price (USD)");
		expect(select.name).toBe("os0");
		expect(select.options.map((o) => [o.value, o.label])).toEqual([
			["1:", "1: $50.00"],
			["2:", "2: $80.00"],
			["8:", "8: $200.00"],
		]);
		expect(submit).toMatchObject({
			image: "https://www.paypalobjects.com/en_US/i/btn/btn_buynowCC_LG.gif",
			label: "PayPal - The safer, easier way to pay online!",
			name: "submit",
		});
	});

	it("carries a donate form's text field and its button", () => {
		const form = formOf(
			gutenbergToPortableText(
				`<form action="https://www.paypal.com/donate" method="post" target="_top"><input type="hidden" name="business" value="x@example.org"><label>Amount <input type="number" name="amount" required></label><button type="submit">Donate</button></form>`,
			),
		);
		expect([form.action, form.target]).toEqual(["https://www.paypal.com/donate", "_top"]);
		expect(form.items).toMatchObject([
			{ _type: "text", text: "Amount" },
			{ _type: "input", inputType: "number", name: "amount", required: true },
			{ _type: "submit", label: "Donate" },
		]);
	});
});

describe("a form that is not carried", () => {
	it("keeps its text when it posts anywhere but a payment provider, and says why", () => {
		const html = `<form action="https://forms.example.org/submit" method="post"><p>Your name</p><input type="text" name="n"><input type="submit" value="Send"></form>`;
		expect(shape(gutenbergToPortableText(html))).toEqual(["normal: Your name"]);
		expect(externalFormRefusal(html)).toBe(
			"a form posting to forms.example.org, which is not a payment provider the site may post to",
		);
	});

	it("is not carried as part of a payment form when it holds a control the block cannot carry", () => {
		const html = `<form action="https://www.paypal.com/cgi-bin/webscr" method="post"><p>Size</p><input type="radio" name="os0" value="S"> S <input type="image" src="https://www.paypalobjects.com/b.gif" alt="Buy"></form>`;
		expect(shape(gutenbergToPortableText(html))).toEqual(["normal: Size", "normal: S"]);
		expect(externalFormRefusal(html)).toBe(
			"a paypal form holding a radio field, which is not carried",
		);
	});

	// The host's import report (embark external-forms.ts) says the same of where a form sits.
	it("is read as its container's text in a classic table or list, and carried through a div", () => {
		const form = PAYPAL.split(
			'<form action="https://www.paypal.com/cgi-bin/webscr" method="post"></form>',
		)[0]!;
		const types = (html: string) => gutenbergToPortableText(html).map((b) => b._type);
		expect(types(`<table><tr><td>${form}</td></tr></table>`)).not.toContain("externalForm");
		expect(types(`<ul><li>${form}</li></ul>`)).not.toContain("externalForm");
		expect(types(`<div class="pay">${form}</div>`)).toContain("externalForm");
		expect(
			types(
				`<!-- wp:table -->\n<figure class="wp-block-table"><table><tr><td>${form}</td></tr></table></figure>\n<!-- /wp:table -->`,
			),
		).not.toContain("externalForm");
		expect(
			types(`<!-- wp:html -->\n<table><tr><td>${form}</td></tr></table>\n<!-- /wp:html -->`),
		).toContain("externalForm");
	});

	it("draws nothing, and is no refusal, when it holds no control (WordPress's empty form)", () => {
		const html = `<form action="https://www.paypal.com/cgi-bin/webscr" method="post"></form>`;
		expect(gutenbergToPortableText(html)).toEqual([]);
		expect(externalFormRefusal(html)).toBeUndefined();
	});

	it("posts only over https to a host on the list, read as a browser reads it", () => {
		expect(externalFormAction("https://www.paypal.com/cgi-bin/webscr")?.href).toBe(
			"https://www.paypal.com/cgi-bin/webscr",
		);
		for (const action of [
			"http://www.paypal.com/cgi-bin/webscr",
			"https://www.paypal.com.evil.example/x",
			"https://evil.example/www.paypal.com",
			"https://user@www.paypal.com/x",
			"//www.paypal.com/x",
			"/cgi-bin/webscr",
			"javascript:alert(1)",
			"https://www.paypal.com\\@evil.example/",
		]) {
			expect(externalFormAction(action), action).toBeUndefined();
		}
	});
});

describe("a block-editor post's PayPal form", () => {
	it("is a form in a custom HTML block, the HTML around it an HTML block", () => {
		const blocks = gutenbergToPortableText(`<!-- wp:html -->
<div class="pay">${PAYPAL.split('<form action="https://www.paypal.com/cgi-bin/webscr" method="post"></form>')[0]}</div>
<!-- /wp:html -->`);
		expect(shape(blocks).map((s) => s.slice(0, 50))).toEqual([
			'html <div class="pay">',
			"form post https://www.paypal.com/cgi-bin/webscr",
			"html </div>",
		]);
	});

	it("is a form in classic HTML between blocks", () => {
		const blocks = gutenbergToPortableText(`<!-- wp:paragraph -->
<p>Pay here:</p>
<!-- /wp:paragraph -->
${PAYPAL}`);
		expect(shape(blocks).slice(0, 2)).toEqual([
			"normal: Pay here:",
			"form post https://www.paypal.com/cgi-bin/webscr",
		]);
	});

	it("leaves a custom HTML block with no payment form as it was", () => {
		const blocks = gutenbergToPortableText(`<!-- wp:html -->
<form action="https://forms.example.org/x"><input name="q"></form>
<!-- /wp:html -->`);
		expect(shape(blocks)).toEqual([
			'html <form action="https://forms.example.org/x"><input name="q"></form>',
		]);
	});
});
