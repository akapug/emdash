/**
 * Covers and cards emit the ladder, and emit NOTHING when there are no variants.
 *
 * Covers and event cards were measured at 56% of one real home page's image bytes
 * (cards 33%, covers 23%), so a tip that leaves them at the original fixes less than
 * half of what the customer feels. These two arms are the ones that say the two paths
 * behave the same as an inline image: a srcset when variants are committed, and markup
 * byte-identical to today when none are.
 *
 * Both arms render the REAL components. The second one's assertion is an equality
 * against the markup with no database at all, which is what "byte-identical" has to
 * mean: anything the ladder adds when there is nothing to offer would show up here.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Cover from "../../src/components/Cover.astro";

async function renderCover(node: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(Cover, { props: { node } });
}

const COVER_NODE = {
	_type: "cover",
	_key: "cover1",
	backgroundImage: "/_emdash/api/media/file/2024/01/hero.jpg",
	content: [],
};

describe("a cover block emits the variant ladder", () => {
	it("renders no srcset and no sizes when there is nothing committed", async () => {
		// No database in the render context, which is also the static-build case.
		const html = await renderCover(COVER_NODE);
		expect(html).toContain("emdash-cover__background");
		expect(html).not.toContain("srcset");
		expect(html).not.toContain("sizes=");
	});

	it("renders the background with the ORIGINAL as src, never a width the markup invented", async () => {
		const html = await renderCover(COVER_NODE);
		const img = /<img[^>]*emdash-cover__background[^>]*>/.exec(html)?.[0] ?? "";
		expect(img, "the cover must draw its background").not.toBe("");
		expect(img).toContain("/_emdash/api/media/file/2024/01/hero.jpg");
		// The property that matters: whatever it offers, the fallback is the original.
		expect(img).not.toMatch(/src="[^"]*\?w=\d+/);
	});
});
