import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { readAxisSwappedJpegDimensions } from "#media/jpeg-orientation.js";
import { readDimensions } from "#media/placeholder.js";
import { VARIANT_BYTE_CAP, variantRefusal, type VariantParent } from "#media/variants.js";
import { computeContentHash } from "#utils/hash.js";

import type { Storage } from "../../../../../storage/types.js";

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
const PARENT_PREFIX_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

/** Read at most `limit` bytes from a stream, or throw {@link BodyTooLarge}. */
async function boundedBody(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<ArrayBuffer> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw new BodyTooLarge();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out.buffer;
}

async function readParentPrefix(storage: Storage, key: string): Promise<Uint8Array | null> {
	const download = await storage.download(key).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return null;
		throw error;
	});
	if (!download) return null;

	const reader = download.body.getReader();
	const prefix = new Uint8Array(PARENT_PREFIX_BYTES);
	let offset = 0;
	try {
		while (offset < prefix.length) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value.subarray(0, prefix.length - offset);
			prefix.set(chunk, offset);
			offset += chunk.length;
		}
		return prefix.subarray(0, offset);
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * The declared type is the CLIENT'S WORD. The bytes decide, and the parent's format is
 * the second opinion: a variant of a JPEG must be a JPEG, so the stored MIME can never
 * say image/jpeg over real PNG bytes.
 */
function contentTypeOf(bytes: Uint8Array): string | null {
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e)
		return "image/png";
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes.length > 2 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
		return "image/gif";
	if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42)
		return "image/webp";
	if (bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79)
		return "image/avif";
	return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.handleMediaGet || !emdash.storage) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	// B: THE STREAM IS BOUNDED, NOT THE HEADER. Content-Length is a claim by the client;
	// a body with no header, or a lying one, would otherwise be read whole. The reader
	// stops at MAX_MULTIPART_BYTES and answers 413 — so the cap costs one buffer, not an
	// unbounded read.
	if (!request.body) return apiError("INVALID_REQUEST", "A multipart body is required", 400);
	let body: ArrayBuffer;
	try {
		body = await boundedBody(request.body, MAX_MULTIPART_BYTES);
	} catch (error) {
		if (error instanceof BodyTooLarge) {
			return apiError("PAYLOAD_TOO_LARGE", "A variant is one raster image, bounded", 413);
		}
		return apiError("INVALID_REQUEST", "A multipart body is required", 400);
	}

	let form: FormData;
	try {
		form = await new Response(body, {
			headers: { "content-type": request.headers.get("content-type") ?? "" },
		}).formData();
	} catch {
		return apiError("INVALID_REQUEST", "A multipart body is required", 400);
	}

	const mediaId = form.get("mediaId");
	const sizeName = form.get("sizeName");
	const width = Number(form.get("width"));
	const height = Number(form.get("height"));
	// EXACTLY ONE FILE. A body with two parts named `file` is ambiguous, and taking the
	// first would store bytes the caller did not mean to send.
	const fileEntries = form.getAll("file");
	if (fileEntries.length !== 1) {
		return apiError("INVALID_REQUEST", "Exactly one file is required", 400);
	}
	const fileEntry = fileEntries[0];
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

	// THE STORED TYPE IS THE BYTES' TYPE, and it must match the parent's: a variant is a
	// size of the same picture, so a format change is a different file, not a size.
	const actualType = contentTypeOf(bytes);
	if (!actualType)
		return apiError("INVALID_TYPE", "The bytes are not a recognised raster image", 400);
	if (actualType !== media.mimeType) {
		return apiError("INVALID_TYPE", "A variant must be the parent's own format", 400);
	}

	const parent: VariantParent = {
		id: mediaId,
		width: media.width ?? 0,
		height: media.height ?? 0,
		contentHash: media.contentHash,
		status: media.status,
	};
	const offer = {
		sizeName,
		width,
		height,
		decodedWidth: decoded.width,
		decodedHeight: decoded.height,
		contentType: actualType,
		bytes: file.size,
	};
	let refusal = variantRefusal(parent, offer);
	if (
		refusal &&
		actualType === "image/jpeg" &&
		parent.contentHash &&
		!variantRefusal({ ...parent, width: parent.height, height: parent.width }, offer)
	) {
		// The record may already be upright. Only transpose a pair that matches the
		// raw frame of this parent object and has an axis-swapping EXIF orientation.
		let prefix: Uint8Array | null;
		try {
			prefix = await readParentPrefix(emdash.storage, media.storageKey);
		} catch (error) {
			console.error("[media] variant parent read failed:", error);
			return apiError("UNAVAILABLE", "The variant's parent could not be read", 500);
		}
		const raw = prefix && readAxisSwappedJpegDimensions(prefix);
		if (raw?.width === parent.width && raw.height === parent.height) refusal = null;
	}
	if (refusal) return apiError("INVALID_VARIANT", refusal.replaceAll("-", " "), 400);

	// The content hash is the generation. The store checks it again at publication.
	const again = await emdash.handleMediaGet(mediaId);
	if (!again.success) return apiError("NOT_FOUND", "No such media", 404);
	if (
		again.data.item.contentHash !== parent.contentHash ||
		again.data.item.storageKey !== media.storageKey ||
		again.data.item.status !== "ready"
	) {
		return apiError("CONFLICT", "The parent changed while this variant was being stored", 409);
	}

	const contentHash = await computeContentHash(bytes);
	const stored = await emdash.handleMediaVariantStore({
		mediaId,
		sizeName,
		width,
		height,
		parentContentHash: parent.contentHash ?? "",
		bytes,
		contentType: actualType,
		contentHash,
	});
	// A REFUSED STORE IS NOT ALWAYS A 500. The handler answers CONFLICT when the parent
	// changed or the slot belongs to different bytes — both are the caller's situation to
	// resolve, not a server fault, so they keep their 409. Only a genuine failure is 500.
	if (!stored.success) {
		if (stored.error?.code === "CONFLICT") {
			return apiError("CONFLICT", stored.error.message, 409);
		}
		return apiError("UNAVAILABLE", stored.error?.message ?? "The variant could not be stored", 500);
	}

	// A duplicate of the same bytes is a replay, not an error; different bytes at
	// the same slot is a conflict the client must report rather than swallow.
	if (stored.data?.outcome === "conflict") {
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
