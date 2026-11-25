import { describe, expect, it } from "vitest";

import {
	ASPECT_TOLERANCE,
	VARIANT_BYTE_CAP,
	VARIANT_CACHE_CONTROL,
	VARIANT_LADDER,
	chooseVariant,
	variantRefusal,
	variantSrcsetWidths,
	variantUrl,
	type StoredVariant,
	type VariantOffer,
	type VariantParent,
} from "../../src/media/variants.js";

const PARENT: VariantParent = { id: "m1", width: 4414, height: 6122, contentHash: "sha1:current", status: "ready" };

function v(over: Partial<StoredVariant> = {}): StoredVariant {
	return {
		mediaId: "m1",
		sizeName: "medium",
		width: 768,
		height: 1065,
		storageKey: "01ABC-768x1065.jpg",
		bytes: 90_000,
		contentHash: "sha256:aaa",
		parentContentHash: "sha1:current",
		createdAt: "2026-11-24T00:00:00Z",
		...over,
	};
}

function offer(over: Partial<VariantOffer> = {}): VariantOffer {
	return {
		sizeName: "medium",
		width: 768,
		height: 1065,
		decodedWidth: 768,
		decodedHeight: 1065,
		contentType: "image/jpeg",
		bytes: 90_000,
		...over,
	};
}

describe("variantRefusal — every rule, server-side", () => {
	it("accepts a real, same-aspect, smaller, on-ladder raster", () => {
		expect(variantRefusal(PARENT, offer())).toBeNull();
	});
	it("refuses a non-raster however it is named", () => {
		expect(variantRefusal(PARENT, offer({ contentType: "image/svg+xml" }))).toBe("not-a-raster");
		expect(variantRefusal(PARENT, offer({ contentType: "text/html" }))).toBe("not-a-raster");
		expect(variantRefusal(PARENT, offer({ contentType: "application/pdf" }))).toBe("not-a-raster");
	});
	it("refuses bytes over the cap", () => {
		expect(variantRefusal(PARENT, offer({ bytes: VARIANT_BYTE_CAP + 1 }))).toBe("over-the-byte-cap");
	});
	it("trusts the decoded bytes, never the client's claim", () => {
		expect(variantRefusal(PARENT, offer({ width: 768, decodedWidth: 4414 }))).toBe(
			"dimensions-do-not-match-bytes",
		);
	});
	it("refuses a width off the ladder", () => {
		// The decoded dimensions agree with the claim, so the ONLY rule broken is the ladder.
		expect(
			variantRefusal(PARENT, offer({ width: 777, height: 1077, decodedWidth: 777, decodedHeight: 1077 })),
		).toBe("not-on-the-ladder");
	});
	it("refuses a variant that is not smaller than its parent", () => {
		const small: VariantParent = { ...PARENT, width: 300, height: 416 };
		expect(
			variantRefusal(small, offer({ width: 300, height: 416, decodedWidth: 300, decodedHeight: 416 })),
		).toBe("not-smaller-than-the-parent");
	});
	it("refuses a hard crop offered as a smaller version — the 300x300 of a 4414x6122", () => {
		// A 300x300 crop of that portrait is a 33% aspect change, far outside 1%.
		expect(
			variantRefusal(PARENT, offer({ width: 300, height: 300, decodedWidth: 300, decodedHeight: 300 })),
		).toBe("aspect-differs-from-the-parent");
	});
	it("accepts a square size of a square original", () => {
		const square: VariantParent = { ...PARENT, width: 1200, height: 1200 };
		expect(
			variantRefusal(square, offer({ width: 300, height: 300, decodedWidth: 300, decodedHeight: 300 })),
		).toBeNull();
	});
});

describe("chooseVariant — the ?w= resolver", () => {
	it("picks the SMALLEST variant at or above the hint", () => {
		const vs = [
			v({ width: 300, height: 416 }),
			v({ width: 480, height: 666 }),
			v({ width: 768, height: 1065 }),
		];
		expect(chooseVariant(PARENT, vs, 400)?.width).toBe(480);
		expect(chooseVariant(PARENT, vs, 480)?.width).toBe(480);
		expect(chooseVariant(PARENT, vs, 481)?.width).toBe(768);
	});
	it("falls back to the original when nothing is wide enough", () => {
		expect(chooseVariant(PARENT, [v({ width: 300, height: 416 })], 2000)).toBeNull();
	});
	it("IGNORES a variant from an older parent — a replaced parent stops serving its old sizes", () => {
		// The identity is the parent's CONTENT HASH, not a generation: `media` has no
		// version column and a Replace rewrites content_hash.
		expect(
			chooseVariant({ ...PARENT, contentHash: "sha1:new" }, [v({ parentContentHash: "sha1:old" })], 300),
		).toBeNull();
	});
	it("serves nothing for a parent that is not ready", () => {
		expect(chooseVariant({ ...PARENT, status: "draft" }, [v()], 300)).toBeNull();
		expect(chooseVariant({ ...PARENT, status: "deleted" }, [v()], 300)).toBeNull();
	});
	it("serves nothing without a usable width hint", () => {
		expect(chooseVariant(PARENT, [v()], null)).toBeNull();
		expect(chooseVariant(PARENT, [v()], 0)).toBeNull();
		expect(chooseVariant(PARENT, [v()], -5)).toBeNull();
		expect(chooseVariant(PARENT, [v()], 1.5)).toBeNull();
	});
	it("never offers a variant whose aspect does not match, even if it is stored", () => {
		expect(chooseVariant(PARENT, [v({ width: 768, height: 768 })], 300)).toBeNull();
	});
	it("returns the original for a parent with no rows at all — a restore without variants", () => {
		expect(chooseVariant(PARENT, [], 300)).toBeNull();
		expect(chooseVariant(null, [], 300)).toBeNull();
	});
});

describe("the srcset and the URL", () => {
	it("offers only ladder widths BELOW the original — no descriptor that is the original", () => {
		expect(variantSrcsetWidths(5000)).toEqual([...VARIANT_LADDER]);
		expect(variantSrcsetWidths(800)).toEqual([300, 480, 768]);
		expect(variantSrcsetWidths(300)).toEqual([]);
		expect(variantSrcsetWidths(undefined)).toEqual([]);
	});
	it("builds the PARENT's url with a width hint, never a variant key", () => {
		const u = variantUrl("/_emdash/api/media/file/01ABC.jpg", 768);
		expect(u).toBe("/_emdash/api/media/file/01ABC.jpg?w=768");
		expect(u).not.toContain("-768x");
	});
	it("keeps an absolute url absolute and its origin", () => {
		expect(variantUrl("https://site.example/_emdash/api/media/file/01ABC.jpg", 480)).toBe(
			"https://site.example/_emdash/api/media/file/01ABC.jpg?w=480",
		);
	});
	it("the width-hinted url is NEVER immutable — a rolled-back variant must not sit in a browser", () => {
		expect(VARIANT_CACHE_CONTROL).not.toContain("immutable");
		expect(VARIANT_CACHE_CONTROL).toContain("must-revalidate");
		expect(ASPECT_TOLERANCE).toBe(0.01);
	});
});
