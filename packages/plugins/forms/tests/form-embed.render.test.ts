/**
 * A select's placeholder is the line the list opens on: an empty, disabled,
 * selected first option. Without it a list drew its first choice selected, so
 * a required list was answered before the visitor chose anything, and a form
 * migrated from a list that opened on a prompt ("—Please choose an option—")
 * lost the prompt.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import FormEmbed from "../src/astro/FormEmbed.astro";
import type { PublicFormDefinition } from "../src/public-definition.js";
import type { FormField } from "../src/types.js";

const form = (fields: FormField[]): PublicFormDefinition => ({
	name: "Contact",
	slug: "contact",
	pages: [{ fields }],
	settings: { spamProtection: "none", submitLabel: "Send" },
	status: "active",
	_turnstileSiteKey: null,
});

const size = (over: Partial<FormField> = {}): FormField => ({
	id: "size",
	type: "select",
	label: "Size",
	name: "size",
	required: true,
	width: "full",
	options: [
		{ label: "S", value: "S" },
		{ label: "M", value: "M" },
	],
	...over,
});

async function render(definition: PublicFormDefinition): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(FormEmbed, {
		props: { node: { formId: "f1" } },
		locals: { emdash: { handlePublicPluginApiRoute: async () => ({ success: true, data: definition }) } },
	});
}

/** The <option> tags of the one <select>, in order. */
const options = (html: string): string[] => {
	const select = /<select\b[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
	return [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(
		(m) => `${m[1]!.replace(/\s+/g, " ").trim()} | ${m[2]!.trim()}`,
	);
};

describe("FormEmbed select placeholder", () => {
	test("is an empty, disabled, selected first option, and the list stays required", async () => {
		const html = await render(form([size({ placeholder: "—Please choose an option—" })]));
		expect(/<select\b[^>]*\brequired\b/.test(html)).toBe(true);
		expect(options(html)).toEqual([
			'value="" disabled selected | —Please choose an option—',
			'value="S" | S',
			'value="M" | M',
		]);
	});

	test("is not selected when a choice is the default: the default is", async () => {
		const html = await render(form([size({ placeholder: "Pick one", defaultValue: "M" })]));
		expect(options(html)).toEqual(['value="" disabled | Pick one', 'value="S" | S', 'value="M" selected | M']);
	});

	test("a list with no placeholder opens on its first choice, as before", async () => {
		const html = await render(form([size()]));
		expect(options(html)).toEqual(['value="S" | S', 'value="M" | M']);
	});
});
