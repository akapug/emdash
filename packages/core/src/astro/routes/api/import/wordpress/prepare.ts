/**
 * WordPress import prepare endpoint
 *
 * POST /_emdash/api/import/wordpress/prepare
 *
 * Creates collections and fields needed for import.
 * This is called after analyze, before execute.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { wpPrepareBody } from "#api/schemas.js";
import { FIELD_TYPES, type FieldType } from "#schema/types.js";
import type { EmDashHandlers } from "#types";

import { capitalize, sanitizeSlug, singularize, type ImportFieldDef } from "./analyze.js";
import { mecEventFieldType } from "./mapped-fields.js";

/** Validate that a string is a known FieldType, returning undefined if not */
function asFieldType(value: string): FieldType | undefined {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- validated by includes check
	return (FIELD_TYPES as readonly string[]).includes(value) ? (value as FieldType) : undefined;
}

export const prerender = false;

interface PrepareRequest {
	postTypes: Array<{
		name: string;
		collection: string;
		fields?: ImportFieldDef[];
	}>;
}

export interface PrepareResult {
	success: boolean;
	collectionsCreated: string[];
	urlPatternsUpdated?: string[];
	fieldsCreated: Array<{ collection: string; field: string }>;
	errors: Array<{ collection: string; error: string }>;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	try {
		const body = await parseBody(request, wpPrepareBody);
		if (isParseError(body)) return body;

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Zod schema output narrowed to PrepareRequest
		const result = await prepareImport(emdash.db, body as PrepareRequest);

		// Routing caches schema separately from the per-request manifest, so repaired
		// patterns must invalidate that cache just like newly created collections.
		if (result.collectionsCreated.length > 0 || (result.urlPatternsUpdated?.length ?? 0) > 0) {
			emdash.invalidateUrlPatternCache();
		}

		return apiSuccess(result, result.success ? 200 : 400);
	} catch (error) {
		return handleError(error, "Failed to prepare import", "WXR_PREPARE_ERROR");
	}
};

/**
 * The post types whose collection is an EVENTS collection, served at
 * `/events/{slug}`. The host's `NATIVELY_CARRIED` is the same list.
 */
const EVENTS_POST_TYPES: ReadonlySet<string> = new Set(["mec-events", "tribe_events"]);

async function prepareImport(
	db: NonNullable<EmDashHandlers["db"]>,
	request: PrepareRequest,
): Promise<PrepareResult> {
	const { SchemaRegistry } = await import("#schema/registry.js");
	const registry = new SchemaRegistry(db);

	const result: PrepareResult = {
		success: true,
		collectionsCreated: [],
		fieldsCreated: [],
		errors: [],
	};

	for (const postType of request.postTypes) {
		const collectionSlug = sanitizeSlug(postType.collection);
		// AN EVENTS POST TYPE IS AN EVENTS POST TYPE, whatever plugin wrote it.
		// This was `postType.name === "mec-events"`, so The Events Calendar's
		// `tribe_events` collection got NO urlPattern — and the template's
		// `loadEvent` (utils/event-data.ts, `getCollectionByUrlPattern`) never
		// found it, so all 75 imported events 404'd. Measured on a real
		// second-site rehearsal.
		//
		// The host mirrors this list (`packages/host/src/import/plan.ts`,
		// `NATIVELY_CARRIED`); change both together.
		const isEventsType = EVENTS_POST_TYPES.has(postType.name);

		try {
			// Check if collection exists
			let collection = await registry.getCollection(collectionSlug);

			if (!collection) {
				// Create the collection
				const label = capitalize(collectionSlug);
				const labelSingular = capitalize(singularize(collectionSlug));

				// Enable search by default for posts and pages
				const isSearchable = ["posts", "pages", "post", "page"].includes(collectionSlug);
				const supports: ("revisions" | "drafts" | "search")[] = ["revisions", "drafts"];
				if (isSearchable) {
					supports.push("search");
				}

				// Default URL patterns for known post types
				const urlPattern = isEventsType
					? "/events/{slug}"
					: collectionSlug === "pages"
						? "/{slug}"
						: collectionSlug === "posts"
							? "/blog/{slug}"
							: undefined;

				collection = await registry.createCollection({
					slug: collectionSlug,
					label,
					labelSingular,
					description: `Imported from WordPress post type: ${postType.name}`,
					supports,
					urlPattern,
				});

				result.collectionsCreated.push(collectionSlug);
			}

			if (isEventsType && collection.urlPattern !== "/events/{slug}") {
				if (collection.urlPattern) {
					result.errors.push({
						collection: collectionSlug,
						error: `Existing URL pattern "${collection.urlPattern}" conflicts with "/events/{slug}". Reconcile the collection route before importing events.`,
					});
					continue;
				}
				await registry.updateCollection(collectionSlug, { urlPattern: "/events/{slug}" });
				(result.urlPatternsUpdated ??= []).push(collectionSlug);
			}

			// Create missing fields
			const existingFields = await registry.listFields(collection.id);
			const existingFieldsBySlug = new Map(existingFields.map((field) => [field.slug, field]));

			for (const field of postType.fields ?? []) {
				const eventFieldType = isEventsType ? mecEventFieldType(field.slug) : undefined;
				if (
					eventFieldType &&
					(field.type !== eventFieldType || field.required !== (field.slug === "start_date"))
				) {
					result.errors.push({
						collection: collectionSlug,
						error: `Invalid event field "${field.slug}": expected ${eventFieldType} (required: ${field.slug === "start_date"})`,
					});
					continue;
				}
				const existingField = existingFieldsBySlug.get(field.slug);
				if (existingField) {
					if (
						isEventsType &&
						(existingField.type !== field.type || existingField.required !== field.required)
					) {
						result.errors.push({
							collection: collectionSlug,
							error: `Existing field "${field.slug}" conflicts with the requested ${field.type} field (required: ${field.required}). Reconcile its schema before importing events.`,
						});
					}
					continue;
				}

				const fieldType = asFieldType(field.type);
				if (!fieldType) {
					result.errors.push({
						collection: collectionSlug,
						error: `Unknown field type "${field.type}" for field "${field.slug}"`,
					});
					continue;
				}

				await registry.createField(collectionSlug, {
					slug: field.slug,
					label: field.label,
					type: fieldType,
					required: field.required,
					unique: false,
					searchable: field.searchable ?? false,
					sortOrder: existingFields.length + result.fieldsCreated.length,
				});

				result.fieldsCreated.push({
					collection: collectionSlug,
					field: field.slug,
				});
			}

			// Enable search if collection supports it and has searchable fields
			const isSearchable = ["posts", "pages", "post", "page"].includes(collectionSlug);
			if (isSearchable) {
				const { FTSManager } = await import("#search/fts-manager.js");
				const ftsManager = new FTSManager(db);

				const searchableFields = await ftsManager.getSearchableFields(collectionSlug);
				if (searchableFields.length > 0) {
					try {
						await ftsManager.enableSearch(collectionSlug);
					} catch {
						// Ignore - search can be enabled manually later
					}
				}
			}
		} catch (error) {
			console.error(`Prepare error for collection "${collectionSlug}":`, error);
			result.success = false;
			result.errors.push({
				collection: collectionSlug,
				error: "Failed to prepare collection",
			});
		}
	}

	result.success = result.errors.length === 0;
	return result;
}
