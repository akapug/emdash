import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

function block(key: string, text: string, style: string, extra: Record<string, unknown> = {}) {
	return {
		_type: "block",
		_key: key,
		style,
		markDefs: [],
		children: [{ _type: "span", _key: `${key}-span`, text, marks: [] }],
		...extra,
	};
}

async function render(value: unknown[]) {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, { props: { value } });
}

const compact = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\s+/g, " ")
		.replace(/> </g, "><")
		.trim();

describe("PortableText: a quote that holds a list", () => {
	it("renders the quote's paragraph and its list inside one <blockquote>", async () => {
		const html = compact(
			await render([
				block("q1", "Before the list", "blockquote"),
				block("l1", "One", "blockquote", { listItem: "bullet", level: 1 }),
				block("l2", "Nested", "blockquote", { listItem: "bullet", level: 2 }),
				block("l3", "Two", "blockquote", { listItem: "bullet", level: 1 }),
				block("p1", "After the quote", "normal"),
			]),
		);

		expect(html.match(/<blockquote\b/g)).toHaveLength(1);
		const quote = html.slice(html.indexOf("<blockquote"), html.indexOf("</blockquote>"));
		expect(quote).toContain("Before the list");
		expect(quote).toMatch(
			/<ul\b[^>]*><li\b[^>]*>One<ul\b[^>]*><li\b[^>]*>Nested<\/li><\/ul><\/li><li\b[^>]*>Two<\/li><\/ul>/,
		);
		expect(quote).not.toContain("After the quote");
		expect(html.indexOf("After the quote")).toBeGreaterThan(html.indexOf("</blockquote>"));
	});

	it("numbers an ordered list in a quote", async () => {
		const html = compact(
			await render([
				block("l1", "First", "blockquote", { listItem: "number", level: 1 }),
				block("l2", "Second", "blockquote", { listItem: "number", level: 1 }),
			]),
		);

		expect(html.match(/<blockquote\b/g)).toHaveLength(1);
		const quote = html.slice(html.indexOf("<blockquote"), html.indexOf("</blockquote>"));
		expect(quote).toMatch(/<ol\b[^>]*><li\b[^>]*>First<\/li><li\b[^>]*>Second<\/li><\/ol>/);
	});
});
