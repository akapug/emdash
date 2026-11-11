/**
 * PortableTextEditor tests for a page whose first block is a layout block (a migrated page's own
 * layout carrier): the editor opens with a text cursor, and words typed, composed, inserted or
 * pasted onto a selected layout block go after it, never in its place.
 *
 * In a file of their own, so their browser page and editor state are never shared with the rest of
 * the editor's tests (they made "saves an edited block without submitting the surrounding content
 * form" fail in half its runs while they shared PortableTextEditor.test.tsx).
 */

import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";

import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

// ---------------------------------------------------------------------------
// Mocks — heavy components that need network / Astro context
// ---------------------------------------------------------------------------

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

const sectionPickerProps: { current: Record<string, any> | null } = { current: null };
vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: (props: Record<string, any>) => {
		sectionPickerProps.current = props;
		return null;
	},
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

vi.mock("../../src/components/editor/ImageNode", async () => {
	const { Node } = await import("@tiptap/core");

	const ImageExtension = Node.create({
		name: "image",
		group: "block",
		atom: true,
		addAttributes() {
			return {
				src: { default: null },
				alt: { default: "" },
				title: { default: "" },
				caption: { default: "" },
				mediaId: { default: null },
				provider: { default: "local" },
				width: { default: null },
				height: { default: null },
				displayWidth: { default: null },
				displayHeight: { default: null },
			};
		},
		parseHTML() {
			return [{ tag: "img[src]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["img", HTMLAttributes];
		},
	});

	return { ImageExtension };
});

vi.mock("../../src/components/editor/PluginBlockNode", async () => {
	const { Node } = await import("@tiptap/core");

	const PluginBlockExtension = Node.create({
		name: "pluginBlock",
		group: "block",
		atom: true,
		addAttributes() {
			return {
				blockType: { default: "embed" },
				id: { default: "" },
				data: { default: {} },
			};
		},
		parseHTML() {
			return [{ tag: "div[data-plugin-block]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["div", { ...HTMLAttributes, "data-plugin-block": "" }];
		},
	});

	return {
		PluginBlockExtension,
		getEmbedMeta: () => ({ label: "Embed", Icon: () => null }),
		registerPluginBlocks: () => {},
		resolveIcon: () => () => null,
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the ProseMirror editor to mount inside the container */
async function waitForEditor(): Promise<HTMLElement> {
	let pm: HTMLElement | null = null;
	await vi.waitFor(
		() => {
			pm = document.querySelector(".ProseMirror") as HTMLElement | null;
			expect(pm).toBeTruthy();
		},
		{ timeout: 3000 },
	);
	return pm!;
}

/** Focus the ProseMirror contenteditable and wait for it to be focused */
async function focusEditor(pm: HTMLElement) {
	pm.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(pm), { timeout: 1000 });
}

/**
 * Render the editor, wait for it to initialize, and return the Editor instance.
 * Useful for tests that need to type or manipulate content programmatically.
 */
async function renderAndGetEditor(props: Partial<Parameters<typeof PortableTextEditor>[0]> = {}) {
	let capturedEditor: Editor | null = null;
	const screen = await render(
		<PortableTextEditor
			onEditorReady={(editor) => {
				capturedEditor = editor;
			}}
			{...props}
		/>,
	);
	const pm = await waitForEditor();
	await vi.waitFor(() => expect(capturedEditor).toBeTruthy(), { timeout: 2000 });
	return { screen, editor: capturedEditor!, pm };
}

// Shorthand block builders
function textBlock(
	text: string,
	opts: {
		style?: "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote";
		marks?: string[];
		listItem?: "bullet" | "number";
		level?: number;
		markDefs?: Array<{ _type: string; _key: string; [k: string]: unknown }>;
	} = {},
) {
	return {
		_type: "block" as const,
		_key: Math.random().toString(36).slice(2, 9),
		style: opts.style ?? "normal",
		...(opts.listItem ? { listItem: opts.listItem, level: opts.level ?? 1 } : {}),
		children: [
			{
				_type: "span" as const,
				_key: Math.random().toString(36).slice(2, 9),
				text,
				marks: opts.marks,
			},
		],
		markDefs: opts.markDefs,
	};
}
describe("a page whose first block is a layout block", () => {
	// A migrated page's own layout opens with its carrier: an atom block the editor draws as a plugin block.
	const layoutPage = () => [
		{
			_type: "layout-section",
			_key: "ls-0",
			skeleton: { wraps: [], widgets: { l0: { wraps: [] } }, added: { wraps: [] } },
		},
		textBlock("Hello there"),
		{ _type: "layout-section", _key: "ls-1", skeleton: { wraps: [], widgets: {} } },
		textBlock("Second section"),
	];
	const types = (editor: Editor) =>
		(editor.getJSON().content ?? []).map((n: { type: string }) => n.type);

	it("opens with a text cursor in the first words, never with the layout block selected", async () => {
		const { editor } = await renderAndGetEditor({ value: layoutPage() });
		const { selection } = editor.state;
		expect(selection).not.toBeInstanceOf(NodeSelection);
		expect(selection).toBeInstanceOf(TextSelection);
		expect(selection.$from.parent.textContent).toBe("Hello there");
	});

	it("puts a key typed while a layout block is selected in a new paragraph after it, and keeps the block", async () => {
		const onChange = vi.fn();
		const { editor, pm } = await renderAndGetEditor({ value: layoutPage(), onChange });
		await focusEditor(pm);
		editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
		expect(editor.state.selection).toBeInstanceOf(NodeSelection);
		await userEvent.keyboard("x");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
		expect(types(editor)).toEqual([
			"pluginBlock",
			"paragraph",
			"paragraph",
			"pluginBlock",
			"paragraph",
		]);
		expect(editor.state.doc.child(1).textContent).toBe("x");
		const saved = onChange.mock.calls.at(-1)![0] as Array<{ _type: string; _key: string }>;
		expect(saved[0]).toMatchObject({ _type: "layout-section", _key: "ls-0" });
		expect(saved).toHaveLength(5);
	});

	it("keeps a layout block a paste lands on, and puts the pasted words after it", async () => {
		const { editor, pm } = await renderAndGetEditor({ value: layoutPage() });
		await focusEditor(pm);
		const at = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize;
		editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
		const clipboardData = {
			files: [],
			items: [],
			types: ["text/plain"],
			getData: (type: string) => (type === "text/plain" ? "pasted words" : ""),
		};
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: clipboardData });
		editor.view.dom.dispatchEvent(paste);
		expect(types(editor)).toEqual([
			"pluginBlock",
			"paragraph",
			"pluginBlock",
			"paragraph",
			"paragraph",
		]);
		expect(editor.state.doc.child(3).textContent).toBe("pasted words");
	});

	it("keeps a layout block that words from an input method land on, and puts them after it", async () => {
		// A phone keyboard, dictation, an emoji picker or an input method's commit inserts words without a key press.
		const { editor, pm } = await renderAndGetEditor({ value: layoutPage() });
		await focusEditor(pm);
		editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
		await cdp().send("Input.insertText", { text: "x" });
		await vi.waitFor(() => expect(editor.state.doc.child(1).textContent).toBe("x"), {
			timeout: 2000,
		});
		expect(types(editor)).toEqual([
			"pluginBlock",
			"paragraph",
			"paragraph",
			"pluginBlock",
			"paragraph",
		]);
	});

	it("keeps a layout block a composition starts on, and puts the composed words after it", async () => {
		const { editor, pm } = await renderAndGetEditor({ value: layoutPage() });
		await focusEditor(pm);
		editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
		await cdp().send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
		await cdp().send("Input.imeSetComposition", {
			text: "にほ",
			selectionStart: 2,
			selectionEnd: 2,
		});
		await cdp().send("Input.insertText", { text: "日本" });
		await vi.waitFor(() => expect(editor.state.doc.child(1).textContent).toBe("日本"), {
			timeout: 2000,
		});
		expect(types(editor)).toEqual([
			"pluginBlock",
			"paragraph",
			"paragraph",
			"pluginBlock",
			"paragraph",
		]);
	});

	it("leaves the page as it is when an empty paste lands on a selected layout block", async () => {
		const { editor, pm } = await renderAndGetEditor({ value: layoutPage() });
		await focusEditor(pm);
		editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: { files: [], items: [], types: [], getData: () => "" },
		});
		editor.view.dom.dispatchEvent(paste);
		// With nothing to paste, ProseMirror reads the clipboard again through a hidden element, 50 ms on.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(types(editor)).toEqual(["pluginBlock", "paragraph", "pluginBlock", "paragraph"]);
	});

	it("gives a numbered list pasted onto a selected layout block its own identity, as a paste anywhere else does", async () => {
		const { editor, pm } = await renderAndGetEditor({ value: layoutPage() });
		await focusEditor(pm);
		editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
		const html = '<ol start="3"><li><p>a</p></li><li><p>b</p></li></ol>';
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: {
				files: [],
				items: [],
				types: ["text/html"],
				getData: (type: string) => (type === "text/html" ? html : ""),
			},
		});
		editor.view.dom.dispatchEvent(paste);
		expect(types(editor)).toEqual([
			"pluginBlock",
			"orderedList",
			"paragraph",
			"pluginBlock",
			"paragraph",
		]);
		const list = editor.state.doc.child(1);
		expect(list.attrs.listStart).toBe(3);
		expect(String(list.attrs.listId)).not.toMatch(/^legacy:/);
	});

});
