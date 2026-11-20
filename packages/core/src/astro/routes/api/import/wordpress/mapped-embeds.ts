import {
	coreTransformers,
	gutenbergToPortableText,
	htmlToPortableText,
	type BlockTransformer,
	type ConvertOptions,
	type PortableTextBlock,
	type PortableTextTextBlock,
} from "@emdash-cms/gutenberg-to-portable-text";
import { z } from "zod";

const unavailableView = z.object({ version: z.literal(1), viewSlug: z.literal("") }).strict();
const eventView = z
	.object({
		version: z.literal(1),
		viewSlug: z.string().min(1),
		mode: z.enum(["upcoming", "past"]),
		order: z.enum(["asc", "desc"]),
		layout: z.enum(["list", "grid", "tile"]),
		start: z.enum(["today", "start_current_month"]),
		limit: z.number().int().min(1).max(100).optional(),
		navigation: z.literal(false).optional(),
		filters: z
			.object({
				category: z.array(z.string().min(1)).optional(),
				location: z.array(z.string().min(1)).optional(),
				organizer: z.array(z.string().min(1)).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
const mappedEmbed = z
	.object({
		_type: z.literal("embed"),
		_key: z.string().min(1),
		provider: z.literal("embark-events"),
		url: z.literal("/events/"),
		events: z.union([eventView, unavailableView]),
	})
	.strict();

export type MappedEmbed = z.infer<typeof mappedEmbed>;
export const mappedEmbedsSchema = z
	.record(z.string().regex(/^[1-9]\d*$/, "Expected a WordPress source ID"), mappedEmbed)
	.optional();

const MEC_SHORTCODE = /(?<!\[)\[MEC\s+id\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))\s*\](?!\])/gi;
const textOf = (block: PortableTextTextBlock) => block.children.map((span) => span.text).join("");

function mapBlocks(
	blocks: PortableTextBlock[],
	map: (block: PortableTextBlock) => PortableTextBlock[],
): PortableTextBlock[] {
	return blocks.flatMap((block) => {
		if (block._type === "columns") {
			return [
				{
					...block,
					columns: block.columns.map((column) => ({
						...column,
						content: mapBlocks(column.content, map),
					})),
				},
			];
		}
		if (block._type === "cover") return [{ ...block, content: mapBlocks(block.content, map) }];
		return map(block);
	});
}

function sliceText(
	block: PortableTextTextBlock,
	from: number,
	to: number,
	key: string,
): PortableTextTextBlock | null {
	let offset = 0;
	const children = block.children.flatMap((span) => {
		const start = Math.max(0, from - offset);
		const end = Math.min(span.text.length, to - offset);
		offset += span.text.length;
		return end > start ? [{ ...span, text: span.text.slice(start, end) }] : [];
	});
	return children.length ? { ...block, _key: key, children } : null;
}

export function contentWithMappedEmbed(
	source: string,
	embed: MappedEmbed,
	options: ConvertOptions,
): { content: PortableTextBlock[]; warnings: string[] } {
	const convertHtml =
		(fallback: BlockTransformer): BlockTransformer =>
		(block, opts, context) =>
			tokens(block.innerHTML).length
				? htmlToPortableText(block.innerHTML, { ...opts, keyGenerator: context.generateKey })
				: fallback(block, opts, context);
	const converted = gutenbergToPortableText(source, {
		...options,
		customTransformers: {
			...options.customTransformers,
			"core/shortcode": convertHtml(coreTransformers.shortcode),
			"core/html": convertHtml(coreTransformers.html),
		},
	});
	// Freeform HTML between Gutenberg blocks uses the converter's HTML fallback.
	const blocks = mapBlocks(converted, (block) =>
		block._type === "htmlBlock" && tokens(block.html).length
			? htmlToPortableText(block.html, options)
			: [block],
	);
	const ids = new Set<string>();
	mapBlocks(blocks, (block) => {
		if (block._type === "block") {
			for (const match of tokens(textOf(block))) ids.add(match[1] ?? match[2] ?? match[3]!);
		}
		return [block];
	});
	if (ids.size === 0) throw new Error("Mapped embed has no unescaped MEC shortcode placement");

	const multipleViews = ids.size > 1;
	const carried: MappedEmbed = multipleViews
		? { ...embed, _key: "mec-unresolved", events: { version: 1, viewSlug: "" } }
		: embed;
	let count = 0;
	const content = mapBlocks(blocks, (block) => {
		if (block._type !== "block") return [block];
		const text = textOf(block);
		const matches = tokens(text);
		if (!matches.length) return [block];
		const parts: PortableTextBlock[] = [];
		let cursor = 0;
		for (const [index, match] of matches.entries()) {
			const before = sliceText(block, cursor, match.index!, `${block._key}-mec-${index}`);
			if (before) parts.push(before);
			parts.push({ ...carried, _key: count++ === 0 ? carried._key : `${carried._key}-${count}` });
			cursor = match.index! + match[0].length;
		}
		const after = sliceText(block, cursor, text.length, `${block._key}-mec-after`);
		if (after) parts.push(after);
		return parts;
	});
	return {
		content,
		warnings: multipleViews
			? [
					`Imported unavailable event embeds: multiple different saved views (${[...ids].join(", ")}) cannot share one mapped view`,
				]
			: [],
	};
}
