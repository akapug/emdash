import {
	gutenbergToPortableText,
	type ConvertOptions,
	type PortableTextBlock,
} from "@emdash-cms/gutenberg-to-portable-text";
import { z } from "zod";

const nonblank = z.string().refine((value) => value.trim().length > 0, "Expected nonblank text");
const unavailableView = z.object({ version: z.literal(1), viewSlug: z.literal("") }).strict();
const eventView = z
	.object({
		version: z.literal(1),
		viewSlug: nonblank,
		mode: z.enum(["upcoming", "past"]),
		order: z.enum(["asc", "desc"]),
		layout: z.enum(["list", "grid", "tile"]),
		start: z.enum(["today", "start_current_month"]),
		limit: z.number().int().min(1).max(100).optional(),
		navigation: z.boolean().optional(),
		filters: z
			.object({
				category: z.array(nonblank).min(1).max(100).optional(),
				location: z.array(nonblank).min(1).max(100).optional(),
				organizer: z.array(nonblank).min(1).max(100).optional(),
			})
			.strict()
			.optional(),
		// The source view's own search/filter bar (MEC sf_status + sf-options), drawn by the
		// template as a no-JS GET form. Same strict shape the template's parseEventView accepts.
		searchBar: z
			.object({ text: z.boolean().optional(), monthYear: z.boolean().optional() })
			.strict()
			.refine((bar) => bar.text === true || bar.monthYear === true, "A search bar needs text or monthYear")
			.optional(),
	})
	.strict()
	.refine(
		(value) => value.navigation !== true || value.layout === "tile",
		"Navigation requires the tile layout",
	);
const mappedEmbed = z
	.object({
		_type: z.literal("embed"),
		_key: z.string().min(1),
		provider: z.literal("embark-events"),
		url: z.literal("/events/"),
		events: z.union([eventView, unavailableView]),
	})
	.strict();
const sourceId = z.string().regex(/^[1-9]\d*$/, "Expected a WordPress source ID");
const postEmbeds = z.union([mappedEmbed, z.record(sourceId, mappedEmbed)]);
export type MappedEmbed = z.infer<typeof mappedEmbed>;
export type MappedPostEmbeds = z.infer<typeof postEmbeds>;
export const mappedEmbedsSchema = z.record(sourceId, postEmbeds).optional();

const LEADING_ZEROES = /^0+(?=\d)/;
const MEC_SHORTCODE = /^\[MEC\s+id\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))\s*\]$/i;
function singleEmbed(value: MappedPostEmbeds): value is MappedEmbed {
	return value._type === "embed";
}

export function contentWithMappedEmbed(
	source: string,
	mapping: MappedPostEmbeds,
	postId: string,
	options: ConvertOptions,
): { content: PortableTextBlock[]; warnings: string[] } {
	const legacy = singleEmbed(mapping);
	const occurrences = new Map<string, number>();
	const emitted: MappedEmbed[] = [];
	const warnings = new Set<string>();
	const content = gutenbergToPortableText(source, {
		...options,
		shortcode: (raw, context) => {
			const match = MEC_SHORTCODE.exec(raw);
			if (!match) return options.shortcode?.(raw, context);
			const id = (match[1] ?? match[2] ?? match[3]!).replace(LEADING_ZEROES, "");
			const ordinal = (occurrences.get(id) ?? 0) + 1;
			occurrences.set(id, ordinal);
			const definition = legacy ? mapping : mapping[id];
			if (!definition)
				warnings.add(
					`Event view ${id} has no supplied definition; imported an unavailable event embed`,
				);
			const block: MappedEmbed = {
				...(definition ?? {
					_type: "embed",
					provider: "embark-events",
					url: "/events/",
					events: { version: 1, viewSlug: "" },
				}),
				_key: `mec-${postId}-${id}-${ordinal}`,
			};
			emitted.push(block);
			return [block];
		},
	});
	if (legacy && occurrences.size === 0)
		throw new Error("Mapped embed has no unescaped MEC shortcode placement");
	if (legacy && occurrences.size > 1) {
		for (const block of emitted) block.events = { version: 1, viewSlug: "" };
		warnings.add(
			`Imported unavailable event embeds: multiple different saved views (${[...occurrences.keys()].join(", ")}) cannot share one mapped view`,
		);
	}
	return { content, warnings: [...warnings] };
}
