import { describe, it, expect } from "vitest";

import {
	_portableTextToProsemirror,
	_prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";

type Shaped = { style?: string; listItem?: string; level?: number; text: string };

const span = (key: string, text: string) => ({ _type: "span", _key: `${key}-s`, text, marks: [] });

/**
 * A classic quote that holds paragraphs and a list, as the WordPress importer
 * converts it: the quote's paragraphs styled "blockquote", the list's items
 * list items (a nested list the next level down), and the text after it.
 */
const imported = [
	{ _type: "block", _key: "q1", style: "blockquote", children: [span("q1", "First paragraph")] },
	{ _type: "block", _key: "q2", style: "blockquote", children: [span("q2", "for instance:")] },
	{
		_type: "block",
		_key: "l1",
		style: "normal",
		listItem: "bullet",
		level: 1,
		children: [span("l1", "Challenge their own training data knowledge")],
	},
	{
		_type: "block",
		_key: "l2",
		style: "normal",
		listItem: "bullet",
		level: 2,
		children: [span("l2", "Take bold counterfactual approaches")],
	},
	{
		_type: "block",
		_key: "l3",
		style: "normal",
		listItem: "bullet",
		level: 1,
		children: [span("l3", "Ask non-obvious questions")],
	},
	{ _type: "block", _key: "p1", style: "normal", children: [span("p1", "After the quote")] },
];

function shape(blocks: unknown[]): Shaped[] {
	return blocks.map((b) => {
		const block = b as {
			style?: string;
			listItem?: string;
			level?: number;
			children?: Array<{ text?: string }>;
		};
		return {
			style: block.style,
			...(block.listItem ? { listItem: block.listItem, level: block.level ?? 1 } : {}),
			text: (block.children ?? []).map((c) => c.text ?? "").join(""),
		};
	});
}

describe("an imported quote that holds a list, through the editor and back", () => {
	it("keeps the quote's paragraphs, the list's items and levels, and the text after it", () => {
		const pm = _portableTextToProsemirror(imported as never);
		const back = _prosemirrorToPortableText(pm as never);
		expect(shape(back)).toEqual(shape(imported));
	});
});
