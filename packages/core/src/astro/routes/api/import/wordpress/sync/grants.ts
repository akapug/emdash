import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { parseBody } from "#api/parse.js";

import { requireScope } from "../../../../../../auth/scopes.js";
import {
	importSyncGrantCreateSchema,
	importSyncGrantRevokeSchema,
} from "../../../../../../import/sync.js";

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
	const denied = requirePerm(locals.user, "import:execute") ?? requireScope(locals, "admin");
	if (denied) return denied;
	if (!locals.emdash?.handleImportSyncGrantCreate || !locals.user) {
		return apiError("IMPORT_SYNC_UNAVAILABLE", "Import sync is unavailable", 501);
	}
	const parsed = await parseBody(request, importSyncGrantCreateSchema);
	if (parsed instanceof Response) return parsed;
	try {
		return unwrapResult(
			await locals.emdash.handleImportSyncGrantCreate(parsed, {
				id: locals.user.id,
				role: locals.user.role,
			}),
		);
	} catch (error) {
		return handleError(error, "Failed to create import grant", "IMPORT_SYNC_GRANT_CREATE_FAILED");
	}
};

export const DELETE: APIRoute = async ({ locals, request }) => {
	const denied = requirePerm(locals.user, "import:execute") ?? requireScope(locals, "admin");
	if (denied) return denied;
	if (!locals.emdash?.handleImportSyncGrantRevoke || !locals.user) {
		return apiError("IMPORT_SYNC_UNAVAILABLE", "Import sync is unavailable", 501);
	}
	const parsed = await parseBody(request, importSyncGrantRevokeSchema);
	if (parsed instanceof Response) return parsed;
	try {
		return unwrapResult(
			await locals.emdash.handleImportSyncGrantRevoke(parsed, {
				id: locals.user.id,
				role: locals.user.role,
			}),
		);
	} catch (error) {
		return handleError(error, "Failed to revoke import grant", "IMPORT_SYNC_GRANT_REVOKE_FAILED");
	}
};
