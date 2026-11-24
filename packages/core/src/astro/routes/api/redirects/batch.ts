/**
 * Batch redirect create endpoint
 *
 * POST /_emdash/api/redirects/batch - Create multiple redirect rules atomically
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleRedirectCreateBatch } from "#api/handlers/redirects.js";
import { isParseError, parseBody } from "#api/parse.js";
import { createRedirectsBatchBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;
	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;
	const db = emdash.db;

	const denied = requirePerm(user, "redirects:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createRedirectsBatchBody);
		if (isParseError(body)) return body;

		const result = await handleRedirectCreateBatch(db, body.rules);
		return unwrapResult(result, 200);
	} catch (error) {
		return handleError(error, "Failed to create redirects", "REDIRECT_CREATE_ERROR");
	}
};
