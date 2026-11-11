/**
 * A FORM THAT POSTS TO A PAYMENT PROVIDER, CARRIED AS A FORM.
 *
 * A PayPal "Buy Now", "Donate" or cart button is a plain HTML form that posts
 * to www.paypal.com/cgi-bin/webscr: hidden fields name the button (and PayPal
 * holds its prices), a select or text field picks an option, and the image or
 * button submits it. No secret is in it and nothing reaches the site: the
 * visitor's browser posts straight to the provider. Read as text, the form's
 * controls were dropped (the renderer's sanitizer draws no form), so a page
 * that said "select your party size and click Buy Now" offered nothing to pick
 * and nothing to click.
 *
 * A form whose action is an https URL on an EXTERNAL_FORM_HOSTS host is an
 * `externalForm` block: its action, method and target, its hidden fields, and
 * what it draws in order (lines of text, selects, text fields, text areas,
 * images and submit buttons). A form that holds a control this block does not
 * carry (a radio, a checkbox, a file field) is not carried at all, because
 * carrying part of a payment form changes what is paid for; nor is a form
 * posting anywhere else. Those keep their text, as before, and the importer's
 * report names them (`externalFormRefusal`).
 *
 * The renderer (core's ExternalForm.astro) checks the action against its own
 * copy of this list before it draws a form, so stored content cannot make it
 * post anywhere else.
 */

import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import type { PortableTextExternalFormBlock, PortableTextExternalFormItem } from "./types.js";

/** The hosts a carried form may post to: PayPal's (its sandbox too, for a site's test button). */
export const EXTERNAL_FORM_HOSTS: readonly string[] = [
	"www.paypal.com",
	"paypal.com",
	"www.sandbox.paypal.com",
];

/** What a browser folds or drops in a URL (a backslash, white space, a control character): an action holding one is refused, not read. */
const UNSAFE_URL_CHAR = /[\\\s\p{Cc}]/u;
const DIGITS = /^\d{1,5}$/;

const PROVIDERS: Readonly<Record<string, string>> = {
	"www.paypal.com": "paypal",
	"paypal.com": "paypal",
	"www.sandbox.paypal.com": "paypal",
};

/** A form element, or the start of one, in HTML. */
export const FORM_PATTERN = /<form\b[^>]*>[\s\S]*?<\/form\s*>/giu;

type Node = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];
const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (el: Element, name: string): string | undefined =>
	el.attrs.find((a) => a.name === name)?.value;

/** The action as the URL a browser posts to, when it is https on an allowed host; otherwise undefined. */
export function externalFormAction(action: string | undefined): URL | undefined {
	const raw = action?.trim() ?? "";
	if (UNSAFE_URL_CHAR.test(raw) || !URL.canParse(raw)) return undefined;
	const url = new URL(raw);
	return url.protocol === "https:" &&
		EXTERNAL_FORM_HOSTS.includes(url.hostname) &&
		!url.username &&
		!url.password
		? url
		: undefined;
}

/** Elements that end a line of the form's text. */
const LINE_BREAKERS = new Set([
	"p",
	"div",
	"br",
	"tr",
	"td",
	"th",
	"table",
	"tbody",
	"thead",
	"tfoot",
	"li",
	"ul",
	"ol",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"fieldset",
	"legend",
	"label",
	"center",
	"section",
]);
/** Elements whose text is not drawn. */
const UNDRAWN = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"math",
	"iframe",
	"object",
	"canvas",
]);
const TEXT_INPUTS = new Set(["text", "email", "number", "tel", "url", ""]);

/**
 * Why a form is not carried as a form: its action is no allowed host, or it
 * holds a control the block does not carry. Undefined when it is carried, or
 * when it draws nothing (no control and no button: WordPress's empty `<form>`).
 */
export function externalFormRefusal(formHtml: string): string | undefined {
	const read = readForm(formHtml);
	if (!read || read.empty) return undefined;
	return read.refusal;
}

/** The form in `formHtml` as an `externalForm` block, or undefined when it is not carried (externalFormRefusal) or draws nothing. */
export function externalFormBlock(
	formHtml: string,
	generateKey: () => string,
): PortableTextExternalFormBlock | undefined {
	const read = readForm(formHtml, generateKey);
	if (!read || read.empty || read.refusal || !read.block) return undefined;
	return read.block;
}

function readForm(
	formHtml: string,
	generateKey: () => string = counter(),
): { empty: boolean; refusal?: string; block?: PortableTextExternalFormBlock } | undefined {
	const form = parseFragment(formHtml).childNodes.find(
		(n): n is Element => isElement(n) && n.tagName === "form",
	);
	if (!form) return undefined;
	const items: PortableTextExternalFormItem[] = [];
	const hidden: PortableTextExternalFormBlock["hidden"] = [];
	const refused: string[] = [];
	let controls = 0;
	let line = "";
	const endLine = () => {
		const text = line.replace(/[\t\n\f\r ]+/g, " ").trim();
		if (text) items.push({ _type: "text", _key: generateKey(), text });
		line = "";
	};
	const walk = (nodes: Node[]) => {
		for (const node of nodes) {
			if (!isElement(node)) {
				if (node.nodeName === "#text") line += (node as DefaultTreeAdapterMap["textNode"]).value;
				continue;
			}
			const tag = node.tagName;
			if (UNDRAWN.has(tag)) continue;
			if (tag === "input") {
				const type = (attr(node, "type") ?? "").trim().toLowerCase();
				const name = attr(node, "name") ?? "";
				const value = attr(node, "value") ?? "";
				if (type === "hidden") {
					if (name) hidden.push({ _key: generateKey(), name, value });
					continue;
				}
				endLine();
				controls++;
				if (type === "image") {
					const src = httpsUrl(attr(node, "src"));
					items.push({
						_type: "submit",
						_key: generateKey(),
						...(src ? { image: src } : {}),
						label: attr(node, "alt") ?? attr(node, "value") ?? "Submit",
						...(name ? { name } : {}),
					});
				} else if (type === "submit") {
					items.push({
						_type: "submit",
						_key: generateKey(),
						label: value || "Submit",
						...(name ? { name, value } : {}),
					});
				} else if (TEXT_INPUTS.has(type)) {
					if (!name) continue;
					items.push({
						_type: "input",
						_key: generateKey(),
						inputType: (type || "text") as "text" | "email" | "number" | "tel" | "url",
						name,
						...(value ? { value } : {}),
						...(attr(node, "placeholder") ? { placeholder: attr(node, "placeholder") } : {}),
						...(attr(node, "maxlength") && DIGITS.test(attr(node, "maxlength")!)
							? { maxLength: Number(attr(node, "maxlength")) }
							: {}),
						...(node.attrs.some((a) => a.name === "required") ? { required: true } : {}),
					});
				} else refused.push(`a ${type} field`);
				continue;
			}
			if (tag === "select") {
				endLine();
				controls++;
				const name = attr(node, "name") ?? "";
				const options = selectOptions(node, generateKey);
				if (!name || node.attrs.some((a) => a.name === "multiple"))
					refused.push("a select it cannot carry");
				else
					items.push({
						_type: "select",
						_key: generateKey(),
						name,
						options,
						...(node.attrs.some((a) => a.name === "required") ? { required: true } : {}),
					});
				continue;
			}
			if (tag === "textarea") {
				endLine();
				controls++;
				const name = attr(node, "name") ?? "";
				if (name) items.push({ _type: "textarea", _key: generateKey(), name });
				continue;
			}
			if (tag === "button") {
				endLine();
				controls++;
				const type = (attr(node, "type") ?? "submit").toLowerCase();
				if (type !== "submit") continue;
				const name = attr(node, "name");
				items.push({
					_type: "submit",
					_key: generateKey(),
					label: textOf(node) || "Submit",
					...(name ? { name, value: attr(node, "value") ?? "" } : {}),
				});
				continue;
			}
			if (tag === "img") {
				// A provider's 1×1 tracking pixel draws nothing.
				if (attr(node, "width") === "1" && attr(node, "height") === "1") continue;
				const src = httpsUrl(attr(node, "src"));
				endLine();
				if (src)
					items.push({ _type: "image", _key: generateKey(), src, alt: attr(node, "alt") ?? "" });
				continue;
			}
			if (tag === "form" || tag === "object" || tag === "embed") continue;
			if (["keygen", "output", "datalist"].includes(tag)) {
				refused.push(`a ${tag}`);
				continue;
			}
			const breaks = LINE_BREAKERS.has(tag);
			if (breaks) endLine();
			walk(node.childNodes);
			if (breaks) endLine();
		}
	};
	walk(form.childNodes);
	endLine();
	const empty = controls === 0;
	const action = externalFormAction(attr(form, "action"));
	if (!action) {
		return {
			empty,
			refusal: `a form posting to ${describeAction(attr(form, "action"))}, which is not a payment provider the site may post to`,
		};
	}
	if (refused.length > 0)
		return {
			empty,
			refusal: `a ${PROVIDERS[action.hostname]} form holding ${[...new Set(refused)].join(", ")}, which is not carried`,
		};
	const method = (attr(form, "method") ?? "get").trim().toLowerCase() === "post" ? "post" : "get";
	const target = (attr(form, "target") ?? "").trim().toLowerCase();
	return {
		empty,
		block: {
			_type: "externalForm",
			_key: generateKey(),
			provider: PROVIDERS[action.hostname]!,
			action: action.href,
			method,
			...(target === "_blank" || target === "_top" || target === "_self" ? { target } : {}),
			hidden,
			items,
		},
	};
}

function selectOptions(select: Element, generateKey: () => string) {
	const options: { _key: string; value: string; label: string; selected?: true }[] = [];
	const walk = (nodes: Node[]) => {
		for (const n of nodes) {
			if (!isElement(n)) continue;
			if (n.tagName === "option") {
				const label = textOf(n);
				options.push({
					_key: generateKey(),
					value: attr(n, "value") ?? label,
					label,
					...(n.attrs.some((a) => a.name === "selected") ? { selected: true as const } : {}),
				});
			} else if (n.tagName === "optgroup") walk(n.childNodes);
		}
	};
	walk(select.childNodes);
	return options;
}

function textOf(el: Element): string {
	let text = "";
	const walk = (nodes: Node[]) => {
		for (const n of nodes) {
			if (isElement(n)) walk(n.childNodes);
			else if (n.nodeName === "#text") text += (n as DefaultTreeAdapterMap["textNode"]).value;
		}
	};
	walk(el.childNodes);
	return text.replace(/[\t\n\f\r ]+/g, " ").trim();
}

function httpsUrl(src: string | undefined): string | undefined {
	const raw = src?.trim() ?? "";
	if (!URL.canParse(raw)) return undefined;
	const url = new URL(raw);
	return url.protocol === "https:" ? url.href : undefined;
}

function describeAction(action: string | undefined): string {
	const raw = action?.trim() ?? "";
	if (!raw) return "this page";
	return URL.canParse(raw) ? new URL(raw).host || raw : raw.slice(0, 120);
}

function counter(): () => string {
	let n = 0;
	return () => `k${n++}`;
}

/**
 * HTML cut around the forms it holds that are carried: the HTML before and
 * after each, and the block for each, in order. The parts are never empty strings.
 */
export function splitExternalForms(
	html: string,
	generateKey: () => string,
): Array<{ html: string } | { block: PortableTextExternalFormBlock }> {
	const parts: Array<{ html: string } | { block: PortableTextExternalFormBlock }> = [];
	let cursor = 0;
	for (const m of html.matchAll(FORM_PATTERN)) {
		const block = externalFormBlock(m[0], generateKey);
		if (!block) continue;
		const before = html.slice(cursor, m.index);
		if (before.trim()) parts.push({ html: before });
		parts.push({ block });
		cursor = m.index + m[0].length;
	}
	const rest = html.slice(cursor);
	if (rest.trim() || parts.length === 0) parts.push({ html: rest });
	return parts;
}
