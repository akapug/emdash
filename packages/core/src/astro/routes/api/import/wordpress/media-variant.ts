import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { readDimensions } from "#media/placeholder.js";
import { VARIANT_BYTE_CAP, variantRefusal, type VariantParent } from "#media/variants.js";
import { computeContentHash } from "#utils/hash.js";

/**
 * `POST /_emdash/api/import/wordpress/media-variant` — store one of the source's
 * own generated sizes against a parent image the import already carried.
 *
 * AUTHORITY, and why it is not simply `content:write`. Attaching a variant changes
 * what an existing ready image SERVES. That is replace-equivalent authority, not a
 * library upload, so the existing routes are the precedent:
 *
 *   - media create checks `media:upload`     (astro/routes/api/media.ts)
 *   - replace checks `requirePerm media:edit_own`, then `requireOwnerPerm` on the
 *     parent's author, and requires `status === "ready"`
 *     (astro/routes/api/media/[id]/replace.ts)
 *
 * This route therefore requires BOTH:
 *   1. the import scope `import:execute` (it is an import action, on the import
 *      surface, next to `analyze`/`execute`), AND
 *   2. the caller's own media mutation authority over THIS parent — the same
 *      owner check `replace.ts` makes.
 *
 * An importer token that satisfies (1) but not (2) is refused. A caller-supplied
 * media ID or a matching aspect ratio is not custody.
 *
 * NOTHING HERE IS PUBLICLY ADDRESSABLE. The object is written under the reserved
 * private prefix and the row is what makes it servable; the public URL is the
 * parent's own, with `?w=`. See `media/variants.ts` for why that matters.
 */

const MAX_MULTIPART_BYTES = VARIANT_BYTE_CAP + 64 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleMediaGet || !emdash.storage) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_MULTIPART_BYTES) {
		return apiError("PAYLOAD_TOO_LARGE", "A variant is one raster image, bounded", 413);
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return apiError("INVALID_REQUEST", "A multipart body is required", 400);
	}

	const mediaId = form.get("mediaId");
	const sizeName = form.get("sizeName");
	const width = Number(form.get("width"));
	const height = Number(form.get("height"));
	const fileEntry = form.get("file");
	const file = fileEntry instanceof File ? fileEntry : null;

	if (typeof mediaId !== "string" || !mediaId)
		return apiError("INVALID_REQUEST", "mediaId is required", 400);
	if (typeof sizeName !== "string" || !sizeName)
		return apiError("INVALID_REQUEST", "sizeName is required", 400);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		return apiError("INVALID_REQUEST", "width and height must be positive integers", 400);
	}
	if (!file) return apiError("INVALID_REQUEST", "file is required", 400);
	if (file.size > VARIANT_BYTE_CAP)
		return apiError("PAYLOAD_TOO_LARGE", "A variant is bounded in bytes", 413);

	const got = await emdash.handleMediaGet(mediaId);
	if (!got.success) return apiError("NOT_FOUND", "No such media", 404);
	const media = got.data.item;

	// (2) the parent's own mutation authority — the same check replace makes.
	const ownerDenied = requireOwnerPerm(
		user,
		media.authorId ?? "",
		"media:edit_own",
		"media:edit_any",
	);
	if (ownerDenied) return ownerDenied;
	if (media.status !== "ready") {
		return apiError("INVALID_STATE", "Only a ready image can receive a variant", 400);
	}

	// The bytes decide the dimensions; the client's claim is only a cross-check.
	const bytes = new Uint8Array(await file.arrayBuffer());
	const decoded = readDimensions(bytes);
	if (!decoded) return apiError("INVALID_TYPE", "The bytes are not a readable raster image", 400);

	const parent: VariantParent = {
		id: mediaId,
		width: media.width ?? 0,
		height: media.height ?? 0,
		generation: media.version ?? 1,
		status: media.status,
	};
	const offer = {
		sizeName,
		width,
		height,
		decodedWidth: decoded.width,
		decodedHeight: decoded.height,
		contentType: file.type,
		bytes: file.size,
	};
	const refusal = variantRefusal(parent, offer);
	if (refusal) return apiError("INVALID_VARIANT", refusal.replaceAll("-", " "), 400);

	// Re-read the parent immediately before committing: a Replace that landed while
	// the bytes were in flight must not receive a variant of the image it replaced.
	const again = await emdash.handleMediaGet(mediaId);
	if (!again.success) return apiError("NOT_FOUND", "No such media", 404);
	if ((again.data.item.version ?? 1) !== parent.generation || again.data.item.status !== "ready") {
		return apiError("CONFLICT", "The parent changed while this variant was being stored", 409);
	}

	const contentHash = await computeContentHash(bytes);
	const stored = await emdash.handleMediaVariantStore({
		mediaId,
		sizeName,
		width,
		height,
		// The parent's CONTENT HASH, not a generation: `media` has no version column, and
		// a Replace rewrites content_hash. This is what binds the variant to the bytes
		// it was made from.
		parentContentHash: media.contentHash ?? "",
		bytes,
		contentType: file.type,
		contentHash,
	});
	if (!stored.success) return apiError("UNAVAILABLE", "The variant could not be stored", 500);

	// A duplicate of the same bytes is a replay, not an error; different bytes at
	// the same slot is a conflict the client must report rather than swallow.
	if (stored.data.outcome === "conflict") {
		return apiError("CONFLICT", "A different variant already owns this slot", 409);
	}
	return new Response(
		JSON.stringify({ outcome: stored.data.outcome, width, height, contentHash }),
		{
			status: stored.data.outcome === "stored" ? 201 : 200,
			headers: { "content-type": "application/json" },
		},
	);
};
