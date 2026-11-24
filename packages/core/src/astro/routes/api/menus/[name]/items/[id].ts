/**
 * Single menu item endpoint
 *
 * PUT    /_emdash/api/menus/:name/items/:id[?locale=xx]
 * DELETE /_emdash/api/menus/:name/items/:id[?locale=xx]
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import {
	handleMenuItemDelete,
	handleMenuItemLabelRepair,
	handleMenuItemUpdate,
} from "#api/handlers/menus.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { localeFilterQuery, updateMenuItemBody } from "#api/schemas.js";
import { compareAndSetMenuItemLabelBody } from "#api/schemas/menus.js";
import { menuTag } from "#cache/chrome-tags.js";

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const name = params.name!;
	const itemId = params.id;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	if (!itemId) {
		return apiError("VALIDATION_ERROR", "id is required", 400);
	}

	const localeQ = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(localeQ)) return localeQ;

	try {
		const body = await parseBody(request, updateMenuItemBody);
		if (isParseError(body)) return body;

		const result = await handleMenuItemUpdate(emdash.db, name, itemId, body, {
			locale: localeQ.locale,
		});
		if (!result.success) return unwrapResult(result);
		if (cache?.enabled) await cache.invalidate({ tags: [menuTag(name)] });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update menu item", "MENU_ITEM_UPDATE_ERROR");
	}
};

// Separate verb so a pre-repair artifact never accepts an unconditional write.
export const PATCH: APIRoute = async ({ params, request, locals, cache }) => {
	const denied = requirePerm(locals.user, "menus:manage");
	if (denied) return denied;
	const { name, id } = params;
	if (!name || !id) return apiError("VALIDATION_ERROR", "menu and item id are required", 400);
	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const body = await parseBody(request, compareAndSetMenuItemLabelBody);
		if (isParseError(body)) return body;
		const result = await handleMenuItemLabelRepair(
			locals.emdash.db,
			name,
			id,
			body.expected,
			body.label,
			query,
		);
		if (result.success && cache?.enabled) await cache.invalidate({ tags: [menuTag(name)] });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to repair menu item label", "MENU_ITEM_UPDATE_ERROR");
	}
};

export const DELETE: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const name = params.name!;
	const itemId = params.id;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	if (!itemId) {
		return apiError("VALIDATION_ERROR", "id is required", 400);
	}

	const localeQ = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(localeQ)) return localeQ;

	try {
		const result = await handleMenuItemDelete(emdash.db, name, itemId, {
			locale: localeQ.locale,
		});
		if (!result.success) return unwrapResult(result);
		if (cache?.enabled) await cache.invalidate({ tags: [menuTag(name)] });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete menu item", "MENU_ITEM_DELETE_ERROR");
	}
};
