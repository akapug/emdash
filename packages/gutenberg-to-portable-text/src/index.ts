/**
 * Gutenberg to Portable Text Converter
 *
 * Converts WordPress Gutenberg block content to Portable Text format.
 * Uses @wordpress/block-serialization-default-parser to parse the hybrid
 * HTML+JSON format that WordPress uses.
 */

import { autop } from "@wordpress/autop";
import { parse } from "@wordpress/block-serialization-default-parser";

import { textAlignOfTag } from "./align.js";
import { autoembedBlock, findAutoembeds, findTopLevelAutoembeds } from "./autoembed.js";
import {
	drawsLine,
	extractDisplaySize,
	imageAlignment,
	parseInlineContent,
	parseInlineSegments,
} from "./inline.js";
import { wptexturize } from "./texturize.js";
import { getTransformer } from "./transformers/index.js";
import type {
	GutenbergBlock,
	PortableTextBlock,
	PortableTextTextBlock,
	ConvertOptions,
	TransformContext,
} from "./types.js";

// Regex patterns for HTML parsing and conversion
const BLOCK_ELEMENT_PATTERN =
	/<(p|h[1-6]|blockquote|pre|ul|ol|figure|div|hr)[^>]*>([\s\S]*?)<\/\1>|<(hr|br)\s*\/?>|<img\s+[^>]+\/?>/gu;
const LINKED_IMAGE_PATTERN = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*<img\s+([^>]+)\/?>\s*<\/a>/gu;
const STANDALONE_IMAGE_PATTERN = /<img\s+[^>]+\/?>/gu;
const IMG_TAG_PATTERN = /<img[^>]+>/i;
const SRC_ATTR_PATTERN = /src=["']([^"']+)["']/i;
const ALT_ATTR_PATTERN = /alt=["']([^"']*)["']/i;
const LIST_ITEM_PATTERN = /<li[^>]*>([\s\S]*?)<\/li>/gu;
const CODE_TAG_PATTERN = /<code[^>]*>([\s\S]*?)<\/code>/i;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const FIGCAPTION_TAG_PATTERN = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i;
const AMP_ENTITY_PATTERN = /&amp;/g;
const LESS_THAN_ENTITY_PATTERN = /&lt;/g;
const GREATER_THAN_ENTITY_PATTERN = /&gt;/g;
const QUOTE_ENTITY_PATTERN = /&quot;/g;
const APOS_ENTITY_PATTERN = /&#039;/g;
const NUMERIC_AMP_ENTITY_PATTERN = /&#0?38;/g;
const HEX_AMP_ENTITY_PATTERN = /&#x26;/gi;
const NBSP_ENTITY_PATTERN = /&nbsp;/g;
/** A block-level element inside a `<div>`: its paragraphs are the div's content, one block each. */
const BLOCK_INSIDE_PATTERN = /<(?:p|h[1-6]|blockquote|pre|ul|ol|figure|hr)\b/i;

// Re-export types
export type {
	GutenbergBlock,
	PortableTextBlock,
	PortableTextTextBlock,
	PortableTextImageBlock,
	PortableTextCodeBlock,
	PortableTextEmbedBlock,
	PortableTextGalleryBlock,
	PortableTextColumnsBlock,
	PortableTextBreakBlock,
	PortableTextHtmlBlock,
	PortableTextButtonBlock,
	PortableTextButtonsBlock,
	PortableTextCoverBlock,
	PortableTextFileBlock,
	PortableTextPullquoteBlock,
	PortableTextSpan,
	PortableTextMarkDef,
	ConvertOptions,
	BlockTransformer,
	TransformContext,
} from "./types.js";

// Re-export transformers for customization
export { defaultTransformers, fallbackTransformer } from "./transformers/index.js";
export * as coreTransformers from "./transformers/core.js";
export * as embedTransformers from "./transformers/embed.js";

// WordPress's typography, for the text an importer stores beside the content (a title, an excerpt).
export { texturizeNote, texturizes, wptexturize } from "./texturize.js";

// Re-export inline utilities
export {
	parseInlineContent,
	extractText,
	extractAlt,
	extractCaption,
	extractSrc,
} from "./inline.js";

/**
 * Default key generator
 */
function createKeyGenerator(): () => string {
	let counter = 0;
	return () => {
		counter++;
		return `key-${counter}-${Math.random().toString(36).substring(2, 7)}`;
	};
}

/**
 * Normalize parsed blocks from the WP parser into our GutenbergBlock type.
 * The WP parser returns `attrs: Record<string, any> | null`, so we normalize
 * null attrs to empty objects and recursively process innerBlocks.
 */
function normalizeBlocks(blocks: ReturnType<typeof parse>): GutenbergBlock[] {
	return blocks.map(
		(block): GutenbergBlock => ({
			blockName: block.blockName,
			attrs: (block.attrs ?? {}) satisfies Record<string, unknown>,
			innerHTML: block.innerHTML,
			innerBlocks: normalizeBlocks(block.innerBlocks),
			innerContent: block.innerContent,
		}),
	);
}

/**
 * Convert WordPress Gutenberg content to Portable Text
 *
 * @param content - WordPress post content (HTML with Gutenberg block comments)
 * @param options - Conversion options
 * @returns Array of Portable Text blocks
 *
 * @example
 * ```ts
 * const portableText = gutenbergToPortableText(`
 *   <!-- wp:paragraph -->
 *   <p>Hello <strong>world</strong>!</p>
 *   <!-- /wp:paragraph -->
 * `);
 * // → [{ _type: "block", style: "normal", children: [...] }]
 * ```
 */
export function gutenbergToPortableText(
	content: string,
	options: ConvertOptions = {},
): PortableTextBlock[] {
	// Handle empty content
	if (!content || !content.trim()) {
		return [];
	}
	// The text as WordPress printed it: the_content runs wptexturize before wpautop.
	const html = options.texturize === false ? content : wptexturize(content);

	// Check if content has Gutenberg blocks
	const hasBlocks = html.includes("<!-- wp:");

	if (!hasBlocks) {
		// Classic editor content - treat as HTML, as WordPress draws it
		return htmlToPortableText(classicParagraphs(html), options);
	}

	// Parse Gutenberg blocks
	const blocks = normalizeBlocks(parse(html));

	// Create key generator
	const generateKey = options.keyGenerator || createKeyGenerator();

	// Create transform context
	const context = createTransformContext(options, generateKey);

	// Transform blocks
	return blocks.flatMap((block) => transformBlock(block, options, context));
}

/**
 * A paragraph that holds one shortcode and nothing else: its tag, attributes,
 * and (for an enclosing one) the content up to its own closer, never past
 * the paragraph's end. The unrolled content loop starts every repeat at a
 * `[`, so a failed match never rescans what it already read.
 */
const SHORTCODE_PARAGRAPH =
	/<p>\s*(\[([a-z][\w-]*)(?:\s[^[\]\n]*)?\](?:(?:[^[<]|<(?!\/p>))*(?:\[(?!\/\2\])(?:[^[<]|<(?!\/p>))*)*\[\/\2\])?)\s*<\/p>/gi;
/** Where an autoembed stands while wpautop runs: a block of its own, which autop never wraps. */
const EMBED_MARK = "data-g2pt-autoembed";
const EMBED_PLACE = /<div data-g2pt-autoembed="(\d+)"><\/div>/g;

/**
 * Classic editor content as WordPress draws it. The classic editor saves
 * plain text between its tags, and WordPress's `the_content` filter runs it
 * through wpautop: a blank line ends a paragraph, and any other newline is a
 * line break. Converted as saved, a newline is a hard break and a blank line
 * two, all in one paragraph: a migrated services page was one block of
 * run-together lines where WordPress drew a paragraph per service.
 * WordPress's own port of wpautop (@wordpress/autop) makes the paragraphs.
 * Content with blocks is not run through it: WordPress does not either.
 *
 * WordPress embeds first (WP_Embed runs at priority 8, wpautop at 10), so an
 * autoembed or an [embed] shortcode found in the content as saved stays a
 * paragraph of its own, where htmlToPortableText finds it again. And after
 * wpautop, WordPress's shortcode_unautop takes the paragraph off a shortcode
 * that stands alone in one, so the shortcode, not a paragraph, is what is
 * there: `[caption]`'s opener, image and caption land where they did before,
 * which is the shape the importer's caption handling reads.
 */
function classicParagraphs(html: string): string {
	const embeds = html.includes(EMBED_MARK) ? [] : findAutoembeds(html);
	let marked = "";
	let cursor = 0;
	for (const [i, e] of embeds.entries()) {
		marked += `${html.slice(cursor, e.start)}\n\n<div ${EMBED_MARK}="${i}"></div>\n\n`;
		cursor = e.end;
	}
	marked += html.slice(cursor);
	return autop(marked)
		.replace(SHORTCODE_PARAGRAPH, "$1")
		.replace(EMBED_PLACE, (_, i: string) => {
			const e = embeds[Number(i)]!;
			return html.slice(e.start, e.end);
		});
}

const IMG_CLASS_ATTR = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * The `alignment` field for an image block from its `<img>` tag's WordPress
 * alignment class (`alignleft`, `alignright`, `aligncenter`), or nothing.
 */
function imageAligned(img: string): { alignment?: "left" | "right" | "center" } {
	const m = IMG_CLASS_ATTR.exec(img);
	return imageAlignment(m?.[1] ?? m?.[2]);
}

/** The `textAlign` field for a text block from the element `html` opens with, or nothing. */
function aligned(html: string): { textAlign?: "left" | "center" | "right" | "justify" } {
	const textAlign = textAlignOfTag(html);
	return textAlign ? { textAlign } : {};
}

/**
 * Convert plain HTML (classic editor) to Portable Text
 */
export function htmlToPortableText(
	html: string,
	options: ConvertOptions = {},
): PortableTextBlock[] {
	const generateKey = options.keyGenerator || createKeyGenerator();
	const blocks: PortableTextBlock[] = [];
	const autoembeds = findAutoembeds(html);

	/**
	 * An element's text as blocks shaped like `shape`, and each image it holds
	 * as an image block of its own where WordPress draws it: before, between
	 * or after that text (parseInlineSegments).
	 */
	const pushInline = (
		inner: string,
		shape: Pick<PortableTextTextBlock, "style" | "listItem" | "level" | "textAlign">,
	) => {
		for (const s of parseInlineSegments(inner, generateKey)) {
			blocks.push(
				"_type" in s
					? s
					: {
							_type: "block",
							_key: generateKey(),
							...shape,
							children: s.children,
							markDefs: s.markDefs.length > 0 ? s.markDefs : undefined,
						},
			);
		}
	};

	const pushParagraph = (text: string) => {
		if (!text) return;
		const { children, markDefs } = parseInlineContent(text, generateKey);
		if (drawsLine(children)) {
			blocks.push({
				_type: "block",
				_key: generateKey(),
				style: "normal",
				children,
				markDefs: markDefs.length > 0 ? markDefs : undefined,
			});
		}
	};

	// Text outside block elements, split around the URLs WordPress autoembeds
	const pushText = (from: number, to: number) => {
		let cursor = from;
		for (const autoembed of autoembeds) {
			if (autoembed.start < from || autoembed.end > to) continue;
			pushParagraph(html.slice(cursor, autoembed.start).trim());
			blocks.push(autoembedBlock(autoembed, generateKey));
			cursor = autoembed.end;
		}
		pushParagraph(html.slice(cursor, to).trim());
	};

	// Split on block-level elements (including standalone img tags)
	let lastIndex = 0;
	let match;

	while ((match = BLOCK_ELEMENT_PATTERN.exec(html)) !== null) {
		const fullMatch = match[0];
		const tag = (match[1] || match[3] || "").toLowerCase();
		const content = match[2] || "";
		const start = match.index;

		// Handle text between matches
		pushText(lastIndex, start);
		lastIndex = start + fullMatch.length;

		// A paragraph holding nothing but a URL WordPress autoembeds
		const autoembed = autoembeds.find((e) => e.start === start && e.end === lastIndex);
		if (autoembed) {
			blocks.push(autoembedBlock(autoembed, generateKey));
			continue;
		}

		// Check for standalone <img> tag (not wrapped in figure/p)
		if (fullMatch.toLowerCase().startsWith("<img")) {
			const srcMatch = fullMatch.match(SRC_ATTR_PATTERN);
			const altMatch = fullMatch.match(ALT_ATTR_PATTERN);
			if (srcMatch?.[1]) {
				const imgUrl = decodeUrlEntities(srcMatch[1]);
				blocks.push({
					_type: "image",
					_key: generateKey(),
					asset: {
						_type: "reference",
						_ref: imgUrl,
						url: imgUrl,
					},
					alt: altMatch?.[1],
					...imageAligned(fullMatch),
					...extractDisplaySize(fullMatch),
				});
			}
			continue;
		}

		// A <div> that holds paragraphs (a classic post wrapped whole in one `<div>`):
		// WordPress draws each of its paragraphs apart, so each is a block, not one run of text.
		// The block pattern is shared and global, so its place in this content is kept across the call.
		if (tag === "div" && BLOCK_INSIDE_PATTERN.test(content)) {
			const at = BLOCK_ELEMENT_PATTERN.lastIndex;
			BLOCK_ELEMENT_PATTERN.lastIndex = 0;
			blocks.push(...htmlToPortableText(content, { ...options, keyGenerator: generateKey }));
			BLOCK_ELEMENT_PATTERN.lastIndex = at;
			continue;
		}

		// Transform based on tag
		switch (tag) {
			case "p":
			case "div": {
				// Extract any images first (including those wrapped in <a> tags)
				// Match: <a...><img...></a> or standalone <img...>
				// Track positions of linked images so we don't double-process
				const linkedImgPositions: Array<{ start: number; end: number }> = [];

				// First extract linked images
				let linkedMatch;
				while ((linkedMatch = LINKED_IMAGE_PATTERN.exec(content)) !== null) {
					const linkUrl = decodeUrlEntities(linkedMatch[1]!);
					const imgAttrs = linkedMatch[2]!;
					const srcMatch = imgAttrs.match(SRC_ATTR_PATTERN);
					const altMatch = imgAttrs.match(ALT_ATTR_PATTERN);
					if (srcMatch?.[1]) {
						const imgUrl = decodeUrlEntities(srcMatch[1]);
						blocks.push({
							_type: "image",
							_key: generateKey(),
							asset: {
								_type: "reference",
								_ref: imgUrl,
								url: imgUrl,
							},
							alt: altMatch?.[1],
							link: linkUrl,
							...imageAligned(imgAttrs),
							...extractDisplaySize(imgAttrs),
						});
					}
					linkedImgPositions.push({
						start: linkedMatch.index,
						end: linkedMatch.index + linkedMatch[0].length,
					});
				}

				// Then extract standalone images (not inside <a> tags)
				let imgMatch;
				while ((imgMatch = STANDALONE_IMAGE_PATTERN.exec(content)) !== null) {
					// Skip if this image is inside a linked image we already processed
					const isLinked = linkedImgPositions.some(
						(pos) => imgMatch!.index >= pos.start && imgMatch!.index < pos.end,
					);
					if (isLinked) continue;

					const srcMatch = imgMatch[0].match(SRC_ATTR_PATTERN);
					const altMatch = imgMatch[0].match(ALT_ATTR_PATTERN);
					if (srcMatch?.[1]) {
						const imgUrl = decodeUrlEntities(srcMatch[1]);
						blocks.push({
							_type: "image",
							_key: generateKey(),
							asset: {
								_type: "reference",
								_ref: imgUrl,
								url: imgUrl,
							},
							alt: altMatch?.[1],
							...imageAligned(imgMatch[0]),
							...extractDisplaySize(imgMatch[0]),
						});
					}
				}

				// Then handle the text content (with images and image links stripped)
				let textContent = content
					.replace(LINKED_IMAGE_PATTERN, "") // Remove linked images
					.replace(STANDALONE_IMAGE_PATTERN, "") // Remove standalone images
					.trim();
				if (textContent) {
					const { children, markDefs } = parseInlineContent(textContent, generateKey);
					if (drawsLine(children)) {
						blocks.push({
							_type: "block",
							_key: generateKey(),
							style: "normal",
							...aligned(fullMatch),
							children,
							markDefs: markDefs.length > 0 ? markDefs : undefined,
						});
					}
				}
				break;
			}

			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6": {
				// A heading that holds an image is drawn with it inside: an image the
				// classic editor centred stands on a line of its own above the words
				// after it, and one it floated floats beside what follows.
				pushInline(content, { style: tag, ...aligned(fullMatch) });
				break;
			}

			case "blockquote": {
				pushInline(content, { style: "blockquote", ...aligned(fullMatch) });
				break;
			}

			case "pre": {
				// Extract code content
				const codeMatch = content.match(CODE_TAG_PATTERN);
				const code = codeMatch?.[1] || content;
				blocks.push({
					_type: "code",
					_key: generateKey(),
					code: decodeHtmlEntities(code),
				});
				break;
			}

			case "ul":
			case "ol": {
				const listItem = tag === "ol" ? "number" : "bullet";
				let liMatch;
				while ((liMatch = LIST_ITEM_PATTERN.exec(content)) !== null) {
					pushInline(liMatch[1] || "", { style: "normal", listItem, level: 1 });
				}
				break;
			}

			case "hr": {
				blocks.push({
					_type: "break",
					_key: generateKey(),
					style: "lineBreak",
				});
				break;
			}

			case "figure": {
				// Check for image
				const imgMatch = content.match(IMG_TAG_PATTERN);
				if (imgMatch) {
					const srcMatch = imgMatch[0].match(SRC_ATTR_PATTERN);
					const altMatch = imgMatch[0].match(ALT_ATTR_PATTERN);
					const captionMatch = content.match(FIGCAPTION_TAG_PATTERN);
					const imgUrl = srcMatch?.[1] ? decodeUrlEntities(srcMatch[1]) : "";

					blocks.push({
						_type: "image",
						_key: generateKey(),
						asset: {
							_type: "reference",
							_ref: imgUrl,
							url: imgUrl || undefined,
						},
						alt: altMatch?.[1],
						caption: captionMatch?.[1]?.replace(HTML_TAG_PATTERN, "").trim(),
						...extractDisplaySize(imgMatch[0]),
					});
				}
				break;
			}
		}
	}

	// Handle remaining text
	pushText(lastIndex, html.length);

	return blocks;
}

/**
 * Create transform context for recursive block transformation
 */
function createTransformContext(
	options: ConvertOptions,
	generateKey: () => string,
): TransformContext {
	const context: TransformContext = {
		generateKey,
		parseInlineContent: (html: string) => parseInlineContent(html, generateKey),
		transformBlocks: (blocks: GutenbergBlock[]) =>
			blocks.flatMap((block) => transformBlock(block, options, context)),
	};
	return context;
}

/**
 * Transform a single block
 */
function transformBlock(
	block: GutenbergBlock,
	options: ConvertOptions,
	context: TransformContext,
): PortableTextBlock[] {
	const transformer = getTransformer(block.blockName, options.customTransformers);
	if (block.blockName !== null) {
		return transformer(block, options, context);
	}

	// Freeform HTML between blocks is classic content, and WordPress autoembeds URLs in it too.
	// Lift those embeds out and keep the HTML around them as it was.
	const html = block.innerHTML;
	const blocks: PortableTextBlock[] = [];
	let cursor = 0;
	for (const autoembed of findTopLevelAutoembeds(html)) {
		blocks.push(
			...transformer(
				{ ...block, innerHTML: html.slice(cursor, autoembed.start) },
				options,
				context,
			),
			autoembedBlock(autoembed, context.generateKey),
		);
		cursor = autoembed.end;
	}
	blocks.push(...transformer({ ...block, innerHTML: html.slice(cursor) }, options, context));
	return blocks;
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(html: string): string {
	return html
		.replace(LESS_THAN_ENTITY_PATTERN, "<")
		.replace(GREATER_THAN_ENTITY_PATTERN, ">")
		.replace(AMP_ENTITY_PATTERN, "&")
		.replace(QUOTE_ENTITY_PATTERN, '"')
		.replace(APOS_ENTITY_PATTERN, "'")
		.replace(NUMERIC_AMP_ENTITY_PATTERN, "&") // &#038; or &#38;
		.replace(HEX_AMP_ENTITY_PATTERN, "&") // &#x26;
		.replace(NBSP_ENTITY_PATTERN, " ");
}

/**
 * Decode HTML entities in URLs (used for image src attributes)
 */
function decodeUrlEntities(url: string): string {
	return url
		.replace(AMP_ENTITY_PATTERN, "&")
		.replace(NUMERIC_AMP_ENTITY_PATTERN, "&")
		.replace(HEX_AMP_ENTITY_PATTERN, "&");
}

/**
 * Parse Gutenberg blocks without converting to Portable Text
 * Useful for inspection and debugging
 */
export function parseGutenbergBlocks(content: string): GutenbergBlock[] {
	if (!content || !content.trim()) {
		return [];
	}
	return normalizeBlocks(parse(content));
}
