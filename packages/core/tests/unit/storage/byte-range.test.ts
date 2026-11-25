import { describe, expect, it } from "vitest";

import { parseByteRange, resolveByteRange } from "../../../src/storage/byte-range.js";

function resolveHeader(header: string, size: number) {
	const range = parseByteRange(header);
	expect(range).not.toBeNull();
	return range && resolveByteRange(range, size);
}

describe("single HTTP byte ranges", () => {
	it.each([null, "", "items=0-1", "bytes=-", "bytes=+1-2", "bytes=0-1,3-4"])(
		"ignores %s when it is not a single byte range",
		(header) => expect(parseByteRange(header)).toBeNull(),
	);

	it("clamps ends and suffixes, including decimal values above the safe integer limit", () => {
		expect(resolveHeader("BYTES=1-90071992547409930", 5)).toEqual({ start: 1, end: 4 });
		expect(resolveHeader("bytes=-90071992547409930", 5)).toEqual({ start: 0, end: 4 });
		expect(resolveHeader("bytes=90071992547409930-", 5)).toBeNull();
	});

	it.each([
		{ range: "bytes=0-0", size: 0 },
		{ range: "bytes=5-", size: 5 },
		{ range: "bytes=4-3", size: 5 },
		{ range: "bytes=-0", size: 5 },
	])("cannot satisfy $range on $size bytes", ({ range, size }) => {
		expect(resolveHeader(range, size)).toBeNull();
	});
});
