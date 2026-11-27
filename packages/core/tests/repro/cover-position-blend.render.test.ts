/**
 * Cover block `backgroundPosition` and `backgroundBlendMode` rendering and validation.
 *
 * Absent fields must render byte-identically to a plain cover (no extra `style` on the
 * background element, no `mix-blend-mode` on the overlay). Valid values emit
 * `object-position` on the background media and `mix-blend-mode` on `.emdash-cover__overlay`.
 * Hostile or out-of-grammar values are dropped completely.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Cover from "../../src/components/Cover.astro";

async function renderCover(node: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(Cover, { props: { node } });
}

const BASE_COVER = {
	_type: "cover",
	_key: "cover-pb-1",
	backgroundImage: "/_emdash/api/media/file/2024/01/hero.jpg",
	overlayColor: "#1a2b3c",
	overlayOpacity: 0.6,
	content: [],
};

describe("Cover backgroundPosition and backgroundBlendMode", () => {
	it("renders byte-identically when both fields are absent or undefined", async () => {
		const baseline = await renderCover(BASE_COVER);
		const withUndefined = await renderCover({
			...BASE_COVER,
			backgroundPosition: undefined,
			backgroundBlendMode: undefined,
		});

		expect(withUndefined).toBe(baseline);

		const img = /<img[^>]*emdash-cover__background[^>]*>/.exec(baseline)?.[0] ?? "";
		expect(img).not.toBe("");
		expect(img).not.toContain("style=");
		expect(baseline).not.toContain("object-position");
		expect(baseline).not.toContain("mix-blend-mode");
	});

	it("emits object-position for valid keyword and percentage backgroundPosition values", async () => {
		const keywordHtml = await renderCover({
			...BASE_COVER,
			backgroundPosition: "center top",
		});
		const keywordImg = /<img[^>]*emdash-cover__background[^>]*>/.exec(keywordHtml)?.[0] ?? "";
		expect(keywordImg).toContain('style="object-position: center top;"');

		const percentHtml = await renderCover({
			...BASE_COVER,
			backgroundPosition: "50% 25%",
		});
		const percentImg = /<img[^>]*emdash-cover__background[^>]*>/.exec(percentHtml)?.[0] ?? "";
		expect(percentImg).toContain('style="object-position: 50% 25%;"');

		const mixedHtml = await renderCover({
			...BASE_COVER,
			backgroundPosition: "  LEFT   20%  ",
		});
		const mixedImg = /<img[^>]*emdash-cover__background[^>]*>/.exec(mixedHtml)?.[0] ?? "";
		expect(mixedImg).toContain('style="object-position: left 20%;"');
	});

	it("emits mix-blend-mode on the overlay for valid backgroundBlendMode values", async () => {
		const overlayHtml = await renderCover({
			...BASE_COVER,
			backgroundBlendMode: "overlay",
		});
		const overlayDiv = /<div[^>]*emdash-cover__overlay[^>]*>/.exec(overlayHtml)?.[0] ?? "";
		expect(overlayDiv).toContain(
			'style="background-color: #1a2b3c; opacity: 0.6; mix-blend-mode: overlay;"',
		);

		const multiplyHtml = await renderCover({
			...BASE_COVER,
			backgroundBlendMode: "MULTIPLY",
		});
		const multiplyDiv = /<div[^>]*emdash-cover__overlay[^>]*>/.exec(multiplyHtml)?.[0] ?? "";
		expect(multiplyDiv).toContain("mix-blend-mode: multiply;");
	});

	it("drops hostile or out-of-grammar values and matches baseline byte-for-byte", async () => {
		const baseline = await renderCover(BASE_COVER);
		const hostileCases = [
			{
				backgroundPosition: "center top; background: url(https://evil.example/x)",
				backgroundBlendMode: "overlay; position: fixed",
			},
			{
				backgroundPosition: 'center" onclick="alert(1)',
				backgroundBlendMode: 'multiply" data-x="1',
			},
			{
				backgroundPosition: "url(javascript:alert(1))",
				backgroundBlendMode: "difference",
			},
			{
				backgroundPosition: "10px 20px",
				backgroundBlendMode: "invalid-mode",
			},
		];

		for (const hostile of hostileCases) {
			const html = await renderCover({ ...BASE_COVER, ...hostile });
			expect(html).toBe(baseline);
			expect(html).not.toContain("object-position");
			expect(html).not.toContain("mix-blend-mode");
			expect(html).not.toContain("url(");
			expect(html).not.toContain("onclick");
		}
	});
});
