/**
 * Schema collection CRUD endpoints
 *
 * GET    /_emdash/api/schema/collections/{slug} - Get collection
 * PUT    /_emdash/api/schema/collections/{slug} - Update collection
 * PATCH  /_emdash/api/schema/collections/{slug} - Conditionally update collection labels
 * DELETE /_emdash/api/schema/collections/{slug} - Delete collection
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleSchemaCollectionLabelsCompareAndSet } from "#api/handlers/schema.js";
import {
	handleSchemaCollectionGet,
	handleSchemaCollectionUpdate,
	handleSchemaCollectionDelete,
} from "#api/index.js";
import { parseBody, parseQuery, isParseError } from "#api/parse.js";
import {
	collectionGetQuery,
	compareAndSetCollectionLabelsBody,
	updateCollectionBody,
} from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	const query = parseQuery(url, collectionGetQuery);
	if (isParseError(query)) return query;

	const result = await handleSchemaCollectionGet(emdash.db, slug, {
		includeFields: query.includeFields ?? false,
	});
	return unwrapResult(result);
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, updateCollectionBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaCollectionUpdate(emdash.db, slug, body);
	emdash.invalidateUrlPatternCache();
	return unwrapResult(result);
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, compareAndSetCollectionLabelsBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaCollectionLabelsCompareAndSet(emdash.db, slug, body);
	if (result.success) emdash.invalidateUrlPatternCache();
	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, url, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug!;
	const force = url.searchParams.get("force") === "true";

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const result = await handleSchemaCollectionDelete(emdash.db, slug, {
		force,
	});
	emdash.invalidateUrlPatternCache();
	return unwrapResult(result);
};
