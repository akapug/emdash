/**
 * The sign-up block is the plugin's own: the editor offers it (the admin's
 * slash menu reads a plugin's `portableTextBlocks` from the manifest), and
 * the site draws it with the component the descriptor's `componentsEntry`
 * names (EmDash merges each entry's `blockComponents` into PortableText).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createPlugin, subscriptionsPlugin } from "../src/index.js";

describe("the emdash-subscribe block is registered", () => {
	it("the editor offers it, with a heading and a button label that start as the words the block says without them", () => {
		const blocks = createPlugin().admin?.portableTextBlocks ?? [];
		expect(blocks.map((b) => b.type)).toEqual(["emdash-subscribe"]);
		// The admin's modal inserts a block only when a field holds a value: each starts with one,
		// and each field's action_id is the key the block stores it under.
		expect(blocks[0]!.fields).toEqual([
			{
				type: "text_input",
				action_id: "heading",
				label: "Heading",
				initial_value: "Get new posts by email",
			},
			{
				type: "text_input",
				action_id: "button",
				label: "Button label",
				initial_value: "Subscribe",
			},
		]);
	});

	it("the site draws it with the plugin's component: the descriptor names the entry the package exports", () => {
		expect(subscriptionsPlugin().componentsEntry).toBe("@emdash-cms/plugin-subscriptions/astro");
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, string>;
		};
		expect(pkg.exports["./astro"]).toBe("./src/astro/index.ts");
	});
});
