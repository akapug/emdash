import { z } from "zod";

import { RESERVED_FIELD_SLUGS } from "#schema/types.js";

import { mappedEmbedsSchema } from "./mapped-embeds.js";

const reservedFields = new Set([
	...RESERVED_FIELD_SLUGS,
	"title",
	"content",
	"excerpt",
	"featured_image",
	"locale",
	"translation_group",
	"authorId",
	"translationOf",
	"createdAt",
	"publishedAt",
	"scheduledAt",
	"seo",
	"references",
	"taxonomies",
	"actor",
	"migrateBlocks",
	"replaceBlocks",
]);

export const mappedFieldsSchema = z
	.record(
		z.string().regex(/^[1-9]\d*$/, "Expected a WordPress source ID"),
		z.record(
			z.string().refine((key) => !key.startsWith("_") && !reservedFields.has(key), {
				message: "Reserved or standard data field cannot be mapped",
			}),
			z.unknown(),
		),
	)
	.optional();

export const wpExecuteConfig = z.object({
	postTypeMappings: z.record(
		z.string(),
		z.object({
			collection: z.string().min(1),
			enabled: z.boolean(),
		}),
	),
	skipExisting: z.boolean(),
	importSections: z.boolean().optional(),
	authorMappings: z.record(z.string(), z.string().nullable()).optional(),
	locale: z.string().optional(),
	importSeo: z.boolean().optional(),
	importComments: z.boolean().optional(),
	mappedFields: mappedFieldsSchema,
	embeds: mappedEmbedsSchema,
});

const eventFields = z
	.object({
		start_date: z.iso.date(),
		end_date: z.iso.date().optional(),
		start_time: z.string().optional(),
		end_time: z.string().optional(),
		timezone: z.string().optional(),
		location: z.string().optional(),
		organizer: z.string().optional(),
		category: z.string().optional(),
		cost: z.string().optional(),
		more_info: z.string().optional(),
		more_info_title: z.string().optional(),
		event_status: z.string().optional(),
		cancelled_reason: z.string().optional(),
		time_note: z.string().optional(),
		all_day: z.boolean().optional(),
		occurrences: z.array(z.iso.date()).optional(),
	})
	.loose();

export function mecEventFieldType(slug: string): "string" | "boolean" | "json" | undefined {
	if (!Object.hasOwn(eventFields.shape, slug)) return undefined;
	return slug === "all_day" ? "boolean" : slug === "occurrences" ? "json" : "string";
}

export function validateMappedFields(
	values: Record<string, unknown>,
	fields: Record<string, { kind: string }>,
	isMecEvent: boolean,
): void {
	for (const key of Object.keys(values)) {
		if (!Object.hasOwn(fields, key)) {
			throw new Error(`Unknown mapped field "${key}" on the target collection`);
		}
		const expectedType = isMecEvent ? mecEventFieldType(key) : undefined;
		if (expectedType && fields[key]?.kind !== expectedType) {
			throw new Error(`Invalid mapped event schema: field "${key}" must use ${expectedType}`);
		}
	}
	// A string field cannot distinguish a calendar date from a datetime, and JSON accepts CSV.
	if (isMecEvent) {
		const parsed = eventFields.safeParse(values);
		if (!parsed.success) {
			throw new Error(
				`Invalid mapped event fields: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
			);
		}
	}
}
