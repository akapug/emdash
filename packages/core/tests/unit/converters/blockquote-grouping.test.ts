/**
 * Regression tests for #1884: consecutive Portable Text blocks with
 * style "blockquote" are one quote (that's what the Gutenberg importer
 * emits for a multi-paragraph <blockquote>), but the editor converter
 * turned each block into its own blockquote node. The visible symptoms:
 * a single quote renders/edits as several disconnected quotes, and
 * merging them in the editor never survives a reload because the
 * PM → PT serializer flattens a multi-paragraph quote back into
 * consecutive blocks.
 */

import { describe, it, expect } from "vitest";

import { portableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextBlock,
	PortableTextTextBlock,
} from "../../../src/content/converters/types.js";

function quoteBlock(key: string, text: string): PortableTextBlock {
	return {
		_type: "block",
		_key: key,
		style: "blockquote",
		children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
	};
}

describe("blockquote grouping (#1884)", () => {
	it("merges consecutive blockquote blocks into one blockquote node", () => {
		const doc = portableTextToProsemirror([
			quoteBlock("q1", "If recursive service is requested…"),
			quoteBlock("q2", "- The answer to the query…"),
		]);

		expect(doc.content).toHaveLength(1);
		const quote = doc.content[0];
		expect(quote?.type).toBe("blockquote");
		expect(quote?.content?.map((p) => p.type)).toEqual(["paragraph", "paragraph"]);
		expect(quote?.content?.[0]?.content?.[0]?.text).toBe("If recursive service is requested…");
		expect(quote?.content?.[1]?.content?.[0]?.text).toBe("- The answer to the query…");
	});

	it("does not merge blockquote blocks separated by another block", () => {
		const doc = portableTextToProsemirror([
			quoteBlock("q1", "First quote"),
			{
				_type: "block",
				_key: "p1",
				style: "normal",
				children: [{ _type: "span", _key: "p1-s", text: "Between", marks: [] }],
			},
			quoteBlock("q2", "Second quote"),
		]);

		expect(doc.content?.map((n) => n.type)).toEqual(["blockquote", "paragraph", "blockquote"]);
	});

	it("keeps a multi-paragraph quote stable through PT → PM → PT", () => {
		const original = [quoteBlock("q1", "Paragraph one"), quoteBlock("q2", "Paragraph two")];

		const roundTripped = prosemirrorToPortableText(portableTextToProsemirror(original));

		expect(roundTripped).toHaveLength(2);
		const [first, second] = roundTripped as PortableTextTextBlock[];
		expect(first?.style).toBe("blockquote");
		expect(second?.style).toBe("blockquote");
		expect(first?.children[0]?.text).toBe("Paragraph one");
		expect(second?.children[0]?.text).toBe("Paragraph two");

		// …and importantly, loading that output again yields ONE quote node,
		// so an editor merge doesn't revert on reload.
		const reloaded = portableTextToProsemirror(roundTripped);
		expect(reloaded.content).toHaveLength(1);
		expect(reloaded.content[0]?.type).toBe("blockquote");
	});

	it("keeps a quote's list inside the quote, and a list after it outside", () => {
		// A list in a quote is stored as list items styled "blockquote"; it opens inside
		// the quote node, and a save writes it back the same, so it survives a reload.
		const item = (key: string, text: string, style: string, level = 1): PortableTextBlock => ({
			_type: "block",
			_key: key,
			style,
			listItem: "bullet",
			level,
			children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
		});
		const original = [
			quoteBlock("q1", "Quote"),
			item("l1", "quoted bullet", "blockquote"),
			item("l2", "nested bullet", "blockquote", 2),
			item("o1", "a bullet after the quote", "normal"),
		];

		const doc = portableTextToProsemirror(original);

		expect(doc.content?.map((n) => n.type)).toEqual(["blockquote", "bulletList"]);
		expect(doc.content[0]?.content?.map((n) => n.type)).toEqual(["paragraph", "bulletList"]);

		const back = prosemirrorToPortableText(doc) as PortableTextTextBlock[];
		expect(back.map((b) => [b.style, b.listItem, b.level, b.children[0]?.text])).toEqual([
			["blockquote", undefined, undefined, "Quote"],
			["blockquote", "bullet", 1, "quoted bullet"],
			["blockquote", "bullet", 2, "nested bullet"],
			["normal", "bullet", 1, "a bullet after the quote"],
		]);
	});
});
