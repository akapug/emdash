/**
 * ITEM 164p1: a section the source drew edge to edge breaks out of the body column, and its padding is carried.
 *
 * Measured on adamkoren: 8 of 69 page containers are `hundred_percent="yes"`, and ALL FOUR background heroes are among them, each with
 * 175px top and bottom. Live draws a 408px full-bleed hero; ours drew a 300px inset one with rounded margins, because the cover carries
 * neither the flag nor the padding.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Cover from "../../src/components/Cover.astro";

async function render(node: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(Cover, { props: { node } });
}

const BASE = {
	_type: "cover",
	_key: "k",
	backgroundImage: "/_emdash/api/media/file/hero.jpg",
	content: [],
};

describe("164p1: full-bleed covers and their padding", () => {
	it("breaks out of the column when the source said edge to edge", async () => {
		const html = await render({ ...BASE, fullBleed: true });
		expect(html).toContain("emdash-cover--full-bleed");
	});

	it("carries the section's own padding", async () => {
		const html = await render({ ...BASE, paddingTop: 175, paddingBottom: 175 });
		expect(html).toContain("padding-top: 175px");
		expect(html).toContain("padding-bottom: 175px");
	});

	it("accepts a '175px' string, because a stored block may hold one", async () => {
		const html = await render({ ...BASE, paddingTop: "175px" });
		expect(html).toContain("padding-top: 175px");
	});

	it("REFUSES a hostile or out-of-range padding, byte-identically to no padding at all", async () => {
		// This becomes a CSS length: `175px; color: red`, a negative, a unitless 9999 and a bare word all have to be dropped rather than
		// repaired, and dropping must leave the markup as it would be with the field absent.
		const plain = await render(BASE);
		for (const bad of ["175px; color: red", "-5", 9999, "10em", "auto", "calc(100% - 1px)"]) {
			const html = await render({ ...BASE, paddingTop: bad });
			expect(html).toBe(plain);
			expect(html).not.toContain("color: red");
			expect(html).not.toContain("padding-top");
		}
	});

	it("renders byte-identically when the source said nothing about bleeding or padding", async () => {
		// The whole migration depends on this: a site with neither must produce exactly today's markup.
		const a = await render(BASE);
		const b = await render({
			...BASE,
			fullBleed: false,
			paddingTop: undefined,
			paddingBottom: undefined,
		});
		expect(a).toBe(b);
		expect(a).not.toContain("emdash-cover--full-bleed");
	});
});
