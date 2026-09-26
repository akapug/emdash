import { describe, expect, it } from "vitest";

import type { PortableTextBlock } from "../../../src/content/converters/types.js";
import { extractPlainText, extractSearchableFields } from "../../../src/search/text-extraction.js";

const paragraph = (key: string, text: string): PortableTextBlock => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}s`, text }],
});

describe("extractPlainText", () => {
	it("reads the words inside the columns of a columns block, a nested one included", () => {
		const blocks: PortableTextBlock[] = [
			paragraph("p1", "Before the columns."),
			{
				_type: "columns",
				_key: "c1",
				columns: [
					{ _type: "column", _key: "a", content: [paragraph("p2", "Left column words.")] },
					{
						_type: "column",
						_key: "b",
						content: [
							paragraph("p3", "Right column words."),
							{ _type: "image", _key: "i1", alt: "a photo in a column" },
							{
								_type: "columns",
								_key: "c2",
								columns: [
									{ _type: "column", _key: "c", content: [paragraph("p4", "Nested words.")] },
								],
							},
						],
					},
					"not-a-column",
					{ _type: "column", _key: "empty" },
				],
			},
		];

		const text = extractPlainText(blocks);
		const words = [
			"Before the columns.",
			"Left column words.",
			"Right column words.",
			"a photo in a column",
			"Nested words.",
		];
		for (const said of words) expect(text).toContain(said);
	});

	it("reads the words on a cover block", () => {
		const text = extractPlainText([
			{
				_type: "cover",
				_key: "k1",
				backgroundImage: "https://example.org/bg.jpg",
				content: [paragraph("p1", "Words on the cover.")],
			},
		]);
		expect(text).toBe("Words on the cover.");
	});

	it("ignores a columns or cover block that is not shaped as one", () => {
		expect(
			extractPlainText([
				{ _type: "columns", _key: "c1", columns: "malformed" },
				{ _type: "cover", _key: "k1", content: [null, 3, "text"] },
				paragraph("p1", "Only this."),
			]),
		).toBe("Only this.");
	});

	it("gives a searchable Portable Text field the words in its columns", () => {
		const fields = extractSearchableFields(
			{
				content: [
					{
						_type: "columns",
						_key: "c1",
						columns: [
							{ _type: "column", _key: "a", content: [paragraph("p1", "Findable words.")] },
						],
					},
				],
			},
			["content"],
		);
		expect(fields.content).toBe("Findable words.");
	});
});
