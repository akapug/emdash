// 161: WORDPRESS'S OWN GENERATED SIZES ARE CARRIED AT THEIR OWN WIDTHS.
//
// The variant route has always matched `?w=N` exactly against a stored row, with no ladder. What kept the source's sizes out was
// the IMPORT side, not the route. This lane names the fact so a host can tell an old tenant from a new one, and bounds the width
// to a range instead of a ladder — measured need: real WordPress sites generate 150/524/600/672/1038, and every one of those was
// refused by the six-rung ladder.
import { describe, expect, it } from "vitest";

import {
	MEDIA_VARIANTS_ANY_WIDTH_CAPABILITY,
	VARIANT_MAX_WIDTH,
	VARIANT_MIN_WIDTH,
	importCapabilities,
} from "../../src/astro/routes/api/import/wordpress/analyze.ts";
import { srcsetWidthsFor } from "../../src/media/variant-read.ts";

const variant = (width: number) => ({ width, height: Math.round(width / 1.5) }) as never;

describe("161: the renderer offers EVERY stored width, ladder or not", () => {
	it("a source's own numbers reach the srcset", () => {
		// The exact shape a Simbi attachment has: 150/524/600/1024, none of them on the old ladder except 1024.
		const stored = [150, 524, 600, 1024].map(variant);
		expect(srcsetWidthsFor(stored, 320)).toEqual([150, 524, 600, 1024]);
	});

	it("stops AFTER the first width at or past twice the drawn width — the same rule as before", () => {
		// The stored width that crosses the limit is INCLUDED, and the set ends there: 800 is the limit at a 400px slot, so
		// 600 (below it) does not stop the scan and 1024 does — and is offered. My first arm wrote [150,524,600] from an
		// arithmetic slip, not from the rule.
		expect(srcsetWidthsFor([150, 524, 600, 1024].map(variant), 400)).toEqual([150, 524, 600, 1024]);
	});

	it("CONTROL: a sparse ladder-like set is offered unchanged, so nothing regressed", () => {
		expect(srcsetWidthsFor([300, 480, 768, 1024].map(variant), 300)).toEqual([300, 480, 768]);
	});
});

describe("161: the capability and the width range are named, not implied", () => {
	it("this build advertises any-width variants", () => {
		expect(importCapabilities()).toContain(MEDIA_VARIANTS_ANY_WIDTH_CAPABILITY);
	});

	it("the range is the ruling's: a floor of 1 and a ceiling of 4096", () => {
		expect(VARIANT_MIN_WIDTH).toBe(1);
		expect(VARIANT_MAX_WIDTH).toBe(4096);
	});
});
