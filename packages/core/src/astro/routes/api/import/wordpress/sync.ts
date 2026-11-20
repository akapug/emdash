import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { parseBody, parseQuery } from "#api/parse.js";

import { requireScope } from "../../../../../auth/scopes.js";
import { importSyncRequestSchema } from "../../../../../import/sync.js";

export const prerender = false;

const capabilityQuerySchema = z.object({
	collection: importSyncRequestSchema.shape.collection.optional(),
});

/** Read-only discovery; absence on an older runtime means unsupported, not legacy adoption. */
export const GET: APIRoute = async ({ locals, url }) => {
	const denied = requirePerm(locals.user, "import:execute") ?? requireScope(locals, "admin");
	if (denied) return denied;
	if (!locals.emdash?.getImportSyncCapability) {
		return apiError("IMPORT_SYNC_UNAVAILABLE", "Import sync is unavailable", 501);
	}
	const query = parseQuery(url, capabilityQuerySchema);
	if (query instanceof Response) return query;
	try {
		return apiSuccess(await locals.emdash.getImportSyncCapability(query.collection));
	} catch (error) {
		return handleError(error, "Failed to discover import sync", "IMPORT_SYNC_DISCOVERY_FAILED");
	}
};

/** One item per atomic operation. No preflight GET can grant ownership of an existing row. */
export const POST: APIRoute = async ({ locals, request }) => {
	const denied = requirePerm(locals.user, "import:execute") ?? requireScope(locals, "admin");
	if (denied) return denied;
	if (!locals.emdash?.handleImportSync || !locals.user) {
		return apiError("IMPORT_SYNC_UNAVAILABLE", "Import sync is unavailable", 501);
	}
	const parsed = await parseBody(request, importSyncRequestSchema);
	if (parsed instanceof Response) return parsed;
	try {
		return unwrapResult(
			await locals.emdash.handleImportSync(parsed, {
				id: locals.user.id,
				role: locals.user.role,
			}),
		);
	} catch (error) {
		return handleError(error, "Failed to synchronize imported content", "IMPORT_SYNC_FAILED");
	}
};
