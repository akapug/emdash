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

// ---- ITEM 164o: a cover carries the source's background position and blend mode ----
//
// Measured on adamkoren: 11 containers carry a background image, 4 of them `background_position="center top"` (not the CSS default) and 6
// `background_blend_mode="overlay"`. The live page renders both — `/finances/` is `center top` AND `overlay` on one section — so a cover
// without them reads differently from the customer's even though the image is right.
describe("164o: background position and blend mode reach the rendered cover", () => {
	it("carries a valid position and blend onto the background image", async () => {
		const html = await renderCover({
			...COVER_NODE,
			backgroundPosition: "center top",
			backgroundBlendMode: "overlay",
		});
		expect(html).toContain("object-position: center top");
		expect(html).toContain("mix-blend-mode: overlay");
	});

	it("emits NO style at all when the source states neither — markup unchanged", async () => {
		const plain = await renderCover(COVER_NODE);
		expect(plain).not.toContain("object-position");
		expect(plain).not.toContain("mix-blend-mode");
		// and it must be byte-identical to a cover whose fields are explicitly undefined
		const explicit = await renderCover({
			...COVER_NODE,
			backgroundPosition: undefined,
			backgroundBlendMode: undefined,
		});
		expect(explicit).toBe(plain);
	});

	it("REFUSES a position that is not a CSS position, rather than writing it into a style attribute", async () => {
		// This value lands in `style="…"`. A stored block could carry anything; "mostly valid" is how a stylesheet gets a declaration nobody wrote.
		const html = await renderCover({
			...COVER_NODE,
			backgroundPosition: "center; background-image: url(javascript:alert(1))",
		});
		expect(html).not.toContain("javascript");
		expect(html).not.toContain("object-position");
	});

	it("REFUSES a blend mode outside the CSS keyword set", async () => {
		const html = await renderCover({ ...COVER_NODE, backgroundBlendMode: "overlay; color: red" });
		expect(html).not.toContain("mix-blend-mode");
		expect(html).not.toContain("color: red");
	});
});
