import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

const paypal = (over: Record<string, unknown> = {}) => ({
	_type: "externalForm",
	_key: "f1",
	provider: "paypal",
	action: "https://www.paypal.com/cgi-bin/webscr",
	method: "post",
	hidden: [
		{ _key: "h1", name: "cmd", value: "_s-xclick" },
		{ _key: "h2", name: "hosted_button_id", value: "6EADFSWU3YGJ6" },
		{ _key: "h3", name: "on0", value: 'Number of "people"' },
	],
	items: [
		{ _type: "text", _key: "t1", text: "Number of people in your party: price (USD)" },
		{
			_type: "select",
			_key: "s1",
			name: "os0",
			options: [
				{ _key: "o1", value: "1:", label: "1: $50.00" },
				{ _key: "o2", value: "8:", label: "8: $200.00" },
			],
		},
		{
			_type: "submit",
			_key: "b1",
			label: "Buy Now",
			image: "https://www.paypalobjects.com/en_US/i/btn/btn_buynowCC_LG.gif",
			name: "submit",
		},
	],
	...over,
});

async function render(value: unknown[]) {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, { props: { value } });
}

describe("PortableText: a carried payment form", () => {
	it("draws a form posting to PayPal with its hidden fields, its choices and its image button", async () => {
		const html = await render([paypal()]);
		expect(html).toMatch(
			/<form class="emdash-external-form[^"]*" action="https:\/\/www\.paypal\.com\/cgi-bin\/webscr" method="post"/,
		);
		expect(html).toContain('<input type="hidden" name="cmd" value="_s-xclick"');
		expect(html).toContain('<input type="hidden" name="hosted_button_id" value="6EADFSWU3YGJ6"');
		expect(html).toContain('value="Number of &quot;people&quot;"');
		expect(html).toContain("Number of people in your party: price (USD)");
		expect(html).toMatch(
			/<select name="os0"[^>]*><option value="1:"[^>]*>1: \$50\.00<\/option><option value="8:"[^>]*>8: \$200\.00<\/option><\/select>/,
		);
		expect(html).toMatch(
			/<input type="image" src="https:\/\/www\.paypalobjects\.com\/en_US\/i\/btn\/btn_buynowCC_LG\.gif" alt="Buy Now" name="submit"/,
		);
		expect(html.indexOf("price (USD)")).toBeLessThan(html.indexOf("<select"));
	});

	it("draws nothing for a form whose action is not https on an allowed host", async () => {
		for (const action of [
			"https://evil.example/collect",
			"http://www.paypal.com/cgi-bin/webscr",
			"javascript:alert(1)",
			"https://www.paypal.com.evil.example/x",
			"https://www.paypal.com:8443/cgi-bin/webscr",
			7,
		]) {
			const html = await render([paypal({ action })]);
			expect(html, String(action)).not.toContain("<form");
			expect(html).not.toContain("hosted_button_id");
		}
	});

	it("draws a button, never an image from elsewhere, for a submit whose image is not https", async () => {
		const html = await render([
			paypal({
				items: [{ _type: "submit", _key: "b", label: "Pay", image: "http://x.example/b.gif" }],
			}),
		]);
		expect(html).toMatch(/<button type="submit"[^>]*>Pay<\/button>/);
		expect(html).not.toContain("x.example");
	});
});
