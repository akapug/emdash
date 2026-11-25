import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";

export const prerender = false;

/**
 * `DELETE /_emdash/api/import/wordpress/media-variant/exact` — receipt-based
 * exact-match removal of stored image variants (item 144b).
 *
 * Lives on its own path so an older build without exact matching answers 404
 * instead of treating an exact-shaped body (which has no `widths`) as an
 * administrative delete-all. Accepts ONLY JSON:
 *   `{ mediaId, parentContentHash, exact: [{ width, contentHash, publicationId }] }`.
 *
 * Enforces the same two-step authority as POST (`import:execute` + parent owner
 * mutation authority). Deletes rows ONLY so DB triggers queue object cleanup.
 */
export const DELETE: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleMediaGet || !emdash?.handleMediaVariantDelete) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
	if (!contentType.includes("application/json")) {
		return apiError("INVALID_REQUEST", "A JSON body is required", 400);
	}

	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		return apiError("INVALID_REQUEST", "A valid JSON body is required", 400);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return apiError("INVALID_REQUEST", "A JSON object body is required", 400);
	}

	const mediaId = Reflect.get(parsed, "mediaId");
	const rawWidths = Reflect.get(parsed, "widths");
	const rawParentContentHash = Reflect.get(parsed, "parentContentHash");
	const rawExact = Reflect.get(parsed, "exact");

	if (rawWidths !== undefined) {
		return apiError(
			"INVALID_REQUEST",
			"widths is not accepted on the exact variant delete route",
			400,
		);
	}
	if (typeof mediaId !== "string" || mediaId.trim().length === 0) {
		return apiError("INVALID_REQUEST", "mediaId is required", 400);
	}
	if (typeof rawParentContentHash !== "string" || rawParentContentHash.trim().length === 0) {
		return apiError("INVALID_REQUEST", "parentContentHash is required", 400);
	}
	if (!Array.isArray(rawExact)) {
		return apiError("INVALID_REQUEST", "exact must be an array of variant descriptors", 400);
	}

	const seenWidths = new Set<number>();
	const exact: Array<{ width: number; contentHash: string; publicationId: string }> = [];
	for (const item of rawExact) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return apiError("INVALID_REQUEST", "Each exact entry must be an object", 400);
		}
		const w = Reflect.get(item, "width");
		const ch = Reflect.get(item, "contentHash");
		const pid = Reflect.get(item, "publicationId");
		if (typeof w !== "number" || !Number.isInteger(w) || w <= 0) {
			return apiError("INVALID_REQUEST", "Each exact width must be a positive integer", 400);
		}
		if (seenWidths.has(w)) {
			return apiError("INVALID_REQUEST", "Duplicate width in exact deletion list", 400);
		}
		if (typeof ch !== "string" || ch.trim().length === 0) {
			return apiError("INVALID_REQUEST", "Each exact entry requires contentHash", 400);
		}
		if (typeof pid !== "string" || pid.trim().length === 0) {
			return apiError("INVALID_REQUEST", "Each exact entry requires publicationId", 400);
		}
		seenWidths.add(w);
		exact.push({ width: w, contentHash: ch, publicationId: pid });
	}

	const got = await emdash.handleMediaGet(mediaId);
	if (!got.success) return apiError("NOT_FOUND", "No such media", 404);
	const media = got.data.item;

	const ownerDenied = requireOwnerPerm(
		user,
		media.authorId ?? "",
		"media:edit_own",
		"media:edit_any",
	);
	if (ownerDenied) return ownerDenied;

	const deleted = await emdash.handleMediaVariantDelete({
		mediaId,
		parentContentHash: rawParentContentHash,
		currentParentContentHash: media.contentHash ?? "",
		exact,
	});
	if (!deleted.success || !deleted.data) {
		return apiError(
			"UNAVAILABLE",
			deleted.error?.message ?? "The variants could not be deleted",
			500,
		);
	}

	return new Response(
		JSON.stringify({
			deleted: deleted.data.deleted,
			removed: deleted.data.removed,
			skipped: deleted.data.skipped ?? [],
		}),
		{
			status: 200,
			headers: { "content-type": "application/json" },
		},
	);
};
