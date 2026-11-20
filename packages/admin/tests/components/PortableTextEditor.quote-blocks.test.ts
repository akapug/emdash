import { describe, it, expect } from "vitest";

import {
	_portableTextToProsemirror,
	_prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";

type Shaped = { style?: string; listItem?: string; level?: number; text: string };

const span = (key: string, text: string) => ({ _type: "span", _key: `${key}-s`, text, marks: [] });

const item = (key: string, text: string, style: string, level: number) => ({
	_type: "block",
	_key: key,
	style,
	listItem: "bullet",
	level,
	children: [span(key, text)],
});

/**
 * A classic quote that holds paragraphs and a list, as the WordPress importer
 * converts it: the quote's paragraphs and its list's items styled "blockquote"
 * (a nested list the next level down), then a list and a paragraph after it.
 */
const imported = [
	{ _type: "block", _key: "q1", style: "blockquote", children: [span("q1", "First paragraph")] },
	{ _type: "block", _key: "q2", style: "blockquote", children: [span("q2", "for instance:")] },
	item("l1", "Challenge their own training data knowledge", "blockquote", 1),
	item("l2", "Take bold counterfactual approaches", "blockquote", 2),
	item("l3", "Ask non-obvious questions", "blockquote", 1),
	item("o1", "A list after the quote", "normal", 1),
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
	it("opens as one quote holding its paragraphs and its list, with the list after it outside", () => {
		const pm = _portableTextToProsemirror(imported as never) as {
			content: Array<{ type: string; content?: Array<{ type: string }> }>;
		};
		expect(pm.content.map((n) => n.type)).toEqual(["blockquote", "bulletList", "paragraph"]);
		expect(pm.content[0]!.content!.map((n) => n.type)).toEqual([
			"paragraph",
			"paragraph",
			"bulletList",
		]);
	});

	it("keeps the quote's paragraphs, the list's items and levels, and the text after it", () => {
		const back = _prosemirrorToPortableText(_portableTextToProsemirror(imported as never) as never);
		expect(shape(back)).toEqual(shape(imported));
	});
});
