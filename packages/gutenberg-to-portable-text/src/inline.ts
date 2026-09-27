/**
 * Inline HTML to Portable Text spans converter
 *
 * Parses inline HTML elements (strong, em, a, code, etc.) and converts
 * them to Portable Text spans with marks.
 */

import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

import type { PortableTextImageBlock, PortableTextMarkDef, PortableTextSpan } from "./types.js";
import { sanitizeHref } from "./url.js";

// Regex patterns for inline parsing
const WHITESPACE_PATTERN = /\S/;

// Pre-compiled block tag patterns
const BLOCK_TAG_PATTERNS: Record<string, { open: RegExp; close: RegExp }> = {
	p: { open: /^<p[^>]*>/i, close: /<\/p>$/i },
	h1: { open: /^<h1[^>]*>/i, close: /<\/h1>$/i },
	h2: { open: /^<h2[^>]*>/i, close: /<\/h2>$/i },
	h3: { open: /^<h3[^>]*>/i, close: /<\/h3>$/i },
	h4: { open: /^<h4[^>]*>/i, close: /<\/h4>$/i },
	h5: { open: /^<h5[^>]*>/i, close: /<\/h5>$/i },
	h6: { open: /^<h6[^>]*>/i, close: /<\/h6>$/i },
	li: { open: /^<li[^>]*>/i, close: /<\/li>$/i },
	blockquote: { open: /^<blockquote[^>]*>/i, close: /<\/blockquote>$/i },
	figcaption: { open: /^<figcaption[^>]*>/i, close: /<\/figcaption>$/i },
};

// Regex patterns for extracting attributes
const IMG_ALT_PATTERN = /<img[^>]+alt=["']([^"']*)["']/i;
const FIGCAPTION_PATTERN = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i;
const IMG_SRC_PATTERN = /<img[^>]+src=["']([^"']*)["']/i;
/** One attribute of a tag: its name, and its value quoted either way or bare. A quoted value is read whole, so no attribute is found inside one. */
const TAG_ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const WHOLE_PIXELS_PATTERN = /^\d+$/;
/** A `width` or `height` declaration of an inline style in whole pixels; `max-width` and the like are other properties. */
const STYLE_PIXELS_PATTERN = /(?:^|;)\s*(width|height)\s*:\s*(\d+)px\s*(?:!important\s*)?(?=;|$)/gi;
const URL_AMP_ENTITY_PATTERN = /&amp;/g;
const URL_NUMERIC_AMP_ENTITY_PATTERN = /&#0?38;/g;
const URL_HEX_AMP_ENTITY_PATTERN = /&#x26;/gi;
/** The white space HTML collapses at a line's start and end (a no-break space is not white space to it). */
const LEADING_WHITESPACE = /^[\t\n\f\r ]+/;
const TRAILING_WHITESPACE = /[\t\n\f\r ]+$/;
const CLASS_SEPARATOR = /\s+/;
const IMG_ALIGNMENTS: ReadonlyMap<string, "left" | "right" | "center"> = new Map([
	["alignleft", "left"],
	["alignright", "right"],
	["aligncenter", "center"],
]);

type Node = DefaultTreeAdapterMap["node"];
type TextNode = DefaultTreeAdapterMap["textNode"];
type Element = DefaultTreeAdapterMap["element"];

interface ParseResult {
	children: PortableTextSpan[];
	markDefs: PortableTextMarkDef[];
}

/** A run of an element's text, or an image the element holds. */
export type InlineSegment = ParseResult | PortableTextImageBlock;

/** Where a walk of inline content is: the spans of the run it is in, and the links it met. */
interface Walk {
	children: PortableTextSpan[];
	markDefs: PortableTextMarkDef[];
	markDefMap: Map<string, string>;
	generateKey: () => string;
	/** An `<img>` met on the way, and the link of the `<a>` around it; without it an image holds nothing and is passed over. */
	image?: (walk: Walk, img: Element, link: string | undefined) => void;
}

/** Walk inline HTML (a block tag around it taken off) into spans. */
function walkInline(html: string, generateKey: () => string, image?: Walk["image"]): Walk {
	const walk: Walk = { children: [], markDefs: [], markDefMap: new Map(), generateKey, image };
	walkNodes(parseFragment(stripBlockTags(html)).childNodes, [], undefined, walk);
	return walk;
}

/**
 * Parse inline HTML content into Portable Text spans
 */
export function parseInlineContent(html: string, generateKey: () => string): ParseResult {
	// Handle whitespace-only input BEFORE stripping (parse5 normalizes whitespace away)
	if (html.length > 0 && !WHITESPACE_PATTERN.test(html)) {
		return {
			children: [{ _type: "span", _key: generateKey(), text: html }],
			markDefs: [],
		};
	}
	const { children, markDefs } = walkInline(html, generateKey);
	// Ensure at least one span exists
	if (children.length === 0) {
		children.push({ _type: "span", _key: generateKey(), text: "" });
	}
	return { children, markDefs };
}

/**
 * Inline HTML as WordPress draws it when it holds an image: the text before
 * the image, the image, and the text after it, in that order. A text block
 * holds spans alone, so each image (an `<img>` with a `src`, at any depth,
 * with the link of an `<a>` around it) is an image block of its own between
 * the runs of text around it. A run that draws nothing is no run: a heading
 * that holds an image and no text is the image alone. Each run has the links
 * its own spans name.
 *
 * Content that holds no image is the one run `parseInlineContent` makes of it.
 */
export function parseInlineSegments(html: string, generateKey: () => string): InlineSegment[] {
	if (html.length > 0 && !WHITESPACE_PATTERN.test(html)) {
		return [parseInlineContent(html, generateKey)];
	}
	const pieces: Array<PortableTextSpan[] | PortableTextImageBlock> = [];
	const walk = walkInline(html, generateKey, (at, img, link) => {
		const block = imageBlock(img, link, generateKey);
		if (!block) return;
		pieces.push(at.children, block);
		at.children = [];
	});
	if (pieces.length === 0) {
		if (walk.children.length === 0) {
			walk.children.push({ _type: "span", _key: generateKey(), text: "" });
		}
		return [{ children: walk.children, markDefs: walk.markDefs }];
	}
	pieces.push(walk.children);
	return pieces.flatMap((piece): InlineSegment[] => {
		if (!Array.isArray(piece)) return [piece];
		const children = trimRun(piece);
		if (!drawsLine(children)) return [];
		const named = new Set(children.flatMap((c) => c.marks ?? []));
		const markDefs = walk.markDefs.filter((d) => named.has(d._key)).map((d) => ({ ...d }));
		return [{ children, markDefs }];
	});
}

/**
 * Whether spans draw anything: text, or a no-break space alone. WordPress
 * draws `<p>&nbsp;</p>` (the classic editor's spacer) as a line of its own,
 * one line tall; dropped, every line after it sat that much higher.
 */
export const drawsLine = (children: ReadonlyArray<{ text: string }>) =>
	children.some((c) => c.text.trim() !== "") || children.some((c) => c.text.includes("\u00a0"));

/** A run of spans without the white space HTML does not draw at its start and end, a line break's included. */
function trimRun(run: PortableTextSpan[]): PortableTextSpan[] {
	const spans = run.map((s) => ({ ...s }));
	while (spans[0]) {
		spans[0].text = spans[0].text.replace(LEADING_WHITESPACE, "");
		if (spans[0].text) break;
		spans.shift();
	}
	while (spans.at(-1)) {
		const last = spans.at(-1)!;
		last.text = last.text.replace(TRAILING_WHITESPACE, "");
		if (last.text) break;
		spans.pop();
	}
	return spans;
}

/**
 * An `<img>` as an image block: its `src`, `alt`, the alignment its
 * WordPress class names, the size its tag draws it at, and the link around
 * it. An image with no `src` draws nothing, and is none.
 */
function imageBlock(
	img: Element,
	link: string | undefined,
	generateKey: () => string,
): PortableTextImageBlock | undefined {
	const src = getAttr(img, "src")?.trim();
	if (!src) return undefined;
	return {
		_type: "image",
		_key: generateKey(),
		asset: { _type: "reference", _ref: src, url: src },
		alt: getAttr(img, "alt"),
		...(link ? { link } : {}),
		...imageAlignment(getAttr(img, "class")),
		...displaySize(getAttr(img, "width"), getAttr(img, "height"), getAttr(img, "style")),
	};
}

/**
 * The `alignment` of an image block from its `<img>` tag's class: WordPress's
 * `alignleft`, `alignright` or `aligncenter`, or nothing.
 */
export function imageAlignment(classes: string | undefined): {
	alignment?: "left" | "right" | "center";
} {
	for (const c of (classes ?? "").toLowerCase().split(CLASS_SEPARATOR)) {
		const alignment = IMG_ALIGNMENTS.get(c);
		if (alignment) return { alignment };
	}
	return {};
}

/**
 * Strip common block-level wrapper tags
 */
function stripBlockTags(html: string): string {
	// Remove leading/trailing whitespace
	let stripped = html.trim();

	// Strip common block wrappers
	const blockTags = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "figcaption"];

	for (const tag of blockTags) {
		const patterns = BLOCK_TAG_PATTERNS[tag];
		if (patterns && patterns.open.test(stripped) && patterns.close.test(stripped)) {
			stripped = stripped.replace(patterns.open, "").replace(patterns.close, "").trim();
			break;
		}
	}

	return stripped;
}

/**
 * Recursively walk DOM nodes and build spans
 */
function walkNodes(
	nodes: Node[],
	currentMarks: string[],
	link: string | undefined,
	walk: Walk,
): void {
	const { generateKey } = walk;
	for (const node of nodes) {
		const children = walk.children;
		if (isTextNode(node)) {
			const text = node.value;
			if (text) {
				// Handle line breaks in text
				const parts = text.split("\n");
				for (let i = 0; i < parts.length; i++) {
					const part = parts[i];
					if (part || i > 0) {
						// Add text span
						if (part) {
							children.push({
								_type: "span",
								_key: generateKey(),
								text: part,
								marks: currentMarks.length > 0 ? [...currentMarks] : undefined,
							});
						}
						// Add newline (except after last part)
						if (i < parts.length - 1) {
							// Append newline to previous span or create new one
							if (children.length > 0) {
								const lastChild = children.at(-1);
								if (lastChild) {
									lastChild.text += "\n";
								}
							} else {
								children.push({
									_type: "span",
									_key: generateKey(),
									text: "\n",
								});
							}
						}
					}
				}
			}
		} else if (isElement(node)) {
			const tagName = node.tagName.toLowerCase();

			// Handle <br> as newline
			if (tagName === "br") {
				if (children.length > 0) {
					const lastChild = children.at(-1);
					if (lastChild) {
						lastChild.text += "\n";
					}
				} else {
					children.push({
						_type: "span",
						_key: generateKey(),
						text: "\n",
					});
				}
				continue;
			}

			if (tagName === "img" && walk.image) {
				walk.image(walk, node, link);
				continue;
			}

			// Get mark for this element
			const markResult = getMarkForElement(node, walk.markDefs, walk.markDefMap, generateKey);
			const newMarks = markResult ? [...currentMarks, markResult] : currentMarks;
			const within = tagName === "a" ? sanitizeHref(getAttr(node, "href")) || undefined : link;

			// Recurse into children
			walkNodes(node.childNodes, newMarks, within, walk);
		}
	}
}

/**
 * Get the Portable Text mark for an HTML element
 */
function getMarkForElement(
	element: Element,
	markDefs: PortableTextMarkDef[],
	markDefMap: Map<string, string>,
	generateKey: () => string,
): string | null {
	const tagName = element.tagName.toLowerCase();

	switch (tagName) {
		case "strong":
		case "b":
			return "strong";

		case "em":
		case "i":
			return "em";

		case "u":
			return "underline";

		case "s":
		case "strike":
		case "del":
			return "strike-through";

		case "code":
			return "code";

		case "sup":
			return "superscript";

		case "sub":
			return "subscript";

		case "a": {
			const href = sanitizeHref(getAttr(element, "href"));
			const target = getAttr(element, "target");

			// Check if we already have a markDef for this href
			const existingKey = markDefMap.get(href);
			if (existingKey) {
				return existingKey;
			}

			// Create new mark definition
			const key = generateKey();
			const markDef: PortableTextMarkDef = {
				_type: "link",
				_key: key,
				href,
			};
			if (target === "_blank") {
				markDef.blank = true;
			}
			markDefs.push(markDef);
			markDefMap.set(href, key);
			return key;
		}

		default:
			// Unknown inline element - ignore the tag, process children
			return null;
	}
}

/**
 * Get attribute value from element
 */
function getAttr(element: Element, name: string): string | undefined {
	const attr = element.attrs.find((a) => a.name.toLowerCase() === name);
	return attr?.value;
}

/**
 * Type guard for text nodes
 */
function isTextNode(node: Node): node is TextNode {
	return node.nodeName === "#text";
}

/**
 * Type guard for elements
 */
function isElement(node: Node): node is Element {
	return "tagName" in node;
}

/**
 * Extract plain text from HTML (for alt text, captions)
 */
export function extractText(html: string): string {
	const fragment = parseFragment(html);
	return getTextContent(fragment.childNodes);
}

function getTextContent(nodes: Node[]): string {
	let text = "";
	for (const node of nodes) {
		if (isTextNode(node)) {
			text += node.value;
		} else if (isElement(node)) {
			text += getTextContent(node.childNodes);
		}
	}
	return text.trim();
}

/**
 * Extract alt text from an img element in HTML
 */
export function extractAlt(html: string): string | undefined {
	const match = html.match(IMG_ALT_PATTERN);
	if (match) {
		return match[1]; // Can be empty string ""
	}
	return undefined;
}

/**
 * Extract caption from a figcaption element
 */
export function extractCaption(html: string): string | undefined {
	const match = html.match(FIGCAPTION_PATTERN);
	if (match?.[1]) {
		return extractText(match[1]);
	}
	return undefined;
}

/**
 * The size WordPress draws an image at: the `width` and `height` attributes of
 * its `<img>` tag (the tag, or the attributes after `<img`), as the image
 * block's `displayWidth` and `displayHeight`. The classic editor writes them on
 * every image it inserts (`size-medium` is `width="300" height="256"`), and the
 * block editor on an image it resized. The file the tag names can be larger:
 * the importer moves a `-300x256` size of an upload onto the upload itself,
 * which is the only copy it imports. A value that is not a whole number of
 * pixels (`100%`) is no size, and the first of a repeated attribute counts, as
 * in HTML.
 *
 * The block editor's inline image carries its size in its inline style
 * instead (`style="width: 150px;"`, which it writes on every one it inserts,
 * at most 150 pixels wide). An inline style's width beats the attribute, as in
 * the browser, and the height is then only the style's own: a theme's
 * `height: auto` beats a height attribute, so the image is drawn at its own
 * proportions at that width.
 */
export function extractDisplaySize(img: string): { displayWidth?: number; displayHeight?: number } {
	const first = new Map<string, string>();
	for (const m of img.matchAll(TAG_ATTRIBUTE_PATTERN)) {
		const name = m[1]!.toLowerCase();
		if ((name === "width" || name === "height" || name === "style") && !first.has(name)) {
			first.set(name, m[2] ?? m[3] ?? m[4] ?? "");
		}
	}
	return displaySize(first.get("width"), first.get("height"), first.get("style"));
}

/** The display size a tag's `width`, `height` and `style` values give, each only in whole pixels. */
function displaySize(
	width: string | undefined,
	height: string | undefined,
	style: string | undefined,
): { displayWidth?: number; displayHeight?: number } {
	const declared = new Map<string, string>();
	for (const m of (style ?? "").matchAll(STYLE_PIXELS_PATTERN)) {
		declared.set(m[1]!.toLowerCase(), m[2]!);
	}
	const size: { displayWidth?: number; displayHeight?: number } = {};
	const styled = pixels(declared.get("width"));
	const w = styled ?? pixels(width);
	const h = styled ? pixels(declared.get("height")) : pixels(height);
	if (w) size.displayWidth = w;
	if (h) size.displayHeight = h;
	return size;
}

/** A whole number of pixels above zero, or nothing. */
function pixels(value: string | undefined): number | undefined {
	const v = (value ?? "").trim();
	return WHOLE_PIXELS_PATTERN.test(v) && Number(v) > 0 ? Number(v) : undefined;
}

/**
 * Extract src from an img element
 */
export function extractSrc(html: string): string | undefined {
	const match = html.match(IMG_SRC_PATTERN);
	if (!match?.[1]) return undefined;
	// Decode HTML entities in URLs
	return decodeUrlEntities(match[1]);
}

/**
 * Decode HTML entities commonly found in URLs
 */
export function decodeUrlEntities(url: string): string {
	return url
		.replace(URL_AMP_ENTITY_PATTERN, "&")
		.replace(URL_NUMERIC_AMP_ENTITY_PATTERN, "&")
		.replace(URL_HEX_AMP_ENTITY_PATTERN, "&");
}
