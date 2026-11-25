import type { APIRoute } from "astro";
import { imageSize } from "image-size";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { DEFAULT_MAX_UPLOAD_SIZE, mediaReplaceMetadataForm } from "#api/schemas.js";
import { MUTABLE_MEDIA_CACHE_CONTROL } from "#media/image-endpoint.js";
import { readAxisSwappedJpegDimensions } from "#media/jpeg-orientation.js";
import { normalizeMime } from "#media/mime.js";
import { computeContentHash } from "#utils/hash.js";

export const prerender = false;

const REPLACEABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MULTIPART_FORM_DATA = /^multipart\/form-data\s*;/i;

const tooLarge = () => apiError("PAYLOAD_TOO_LARGE", "Replacement request too large", 413);
const invalidForm = () =>
	apiError("INVALID_REQUEST", "A multipart replacement file is required", 400);

async function readReplacementForm(request: Request, limit: number): Promise<FormData | Response> {
	const contentType = request.headers.get("Content-Type");
	if (!request.body || !contentType || !MULTIPART_FORM_DATA.test(contentType)) {
		return invalidForm();
	}
	if (Number(request.headers.get("Content-Length")) > limit) return tooLarge();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > limit) {
				void reader.cancel().catch(() => undefined);
				return tooLarge();
			}
			chunks.push(value);
		}
	} catch {
		return invalidForm();
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return await new Response(body, { headers: { "Content-Type": contentType } }).formData();
	} catch {
		return invalidForm();
	}
}

function readReplacementImage(
	bytes: Uint8Array,
): { mime: string; width: number; height: number } | null {
	try {
		const { type, width, height } = imageSize(bytes);
		if (
			!width ||
			!height ||
			!Number.isSafeInteger(width) ||
			!Number.isSafeInteger(height) ||
			width < 0 ||
			height < 0
		) {
			return null;
		}
		switch (type) {
			case "jpg": {
				const raw = readAxisSwappedJpegDimensions(bytes);
				return raw
					? { mime: "image/jpeg", width: raw.height, height: raw.width }
					: { mime: "image/jpeg", width, height };
			}
			case "png":
				return { mime: "image/png", width, height };
			case "webp":
				return { mime: "image/webp", width, height };
			default:
				return null;
		}
	} catch {
		return null;
	}
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const editDenied = requirePerm(user, "media:edit_own");
	if (editDenied) return editDenied;
	if (!id) return apiError("INVALID_REQUEST", "Media ID required", 400);
	if (!emdash?.handleMediaGet || !emdash?.handleMediaReplaceMetadata) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (!emdash.storage) return apiError("NO_STORAGE", "Storage not configured", 500);

	const getResult = await emdash.handleMediaGet(id);
	if (!getResult.success) return unwrapResult(getResult);
	const media = getResult.data.item;
	const ownerDenied = requireOwnerPerm(
		user,
		media.authorId ?? "",
		"media:edit_own",
		"media:edit_any",
	);
	if (ownerDenied) return ownerDenied;
	if (media.status !== "ready") {
		return apiError("INVALID_STATE", "Only ready media can be replaced", 400);
	}

	const sourceMime = normalizeMime(media.mimeType);
	if (!REPLACEABLE_IMAGE_TYPES.has(sourceMime)) {
		return apiError("INVALID_TYPE", "Media type cannot be replaced", 400);
	}

	const maxUploadSize = emdash.config.maxUploadSize ?? DEFAULT_MAX_UPLOAD_SIZE;
	const maxRequestSize = maxUploadSize + MULTIPART_OVERHEAD_BYTES;
	if (maxUploadSize <= 0 || !Number.isSafeInteger(maxRequestSize)) {
		return apiError("CONFIGURATION_ERROR", "Invalid maxUploadSize configuration", 500);
	}

	try {
		const formData = await readReplacementForm(request, maxRequestSize);
		if (formData instanceof Response) return formData;
		const files = formData.getAll("file");
		const [file] = files;
		if (files.length === 0) return apiError("NO_FILE", "No file provided", 400);
		if (
			files.length !== 1 ||
			!(file instanceof File) ||
			[...formData.values()].filter((part) => part instanceof File).length !== 1
		) {
			return apiError("INVALID_REQUEST", "Exactly one replacement file is required", 400);
		}
		if (file.size === 0) return apiError("VALIDATION_ERROR", "Replacement file is empty", 400);
		if (file.size > maxUploadSize) {
			return apiError("PAYLOAD_TOO_LARGE", "Upload too large", 413);
		}

		const bytes = new Uint8Array(await file.arrayBuffer());
		const image = readReplacementImage(bytes);
		if (!image) {
			return apiError(
				"INVALID_TYPE",
				"Replacement bytes are not a readable JPEG, PNG, or WebP image",
				400,
			);
		}
		if (image.mime !== sourceMime) {
			return apiError("INVALID_TYPE", "Replacement image format must match the media item", 400);
		}

		const metadataResult = mediaReplaceMetadataForm.safeParse({
			width: formData.get("width"),
			height: formData.get("height"),
		});
		if (!metadataResult.success) {
			return apiError("VALIDATION_ERROR", "Invalid request data", 400, {
				issues: metadataResult.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			});
		}

		const contentHash = await computeContentHash(bytes);
		try {
			await emdash.storage.upload({
				key: media.storageKey,
				body: bytes,
				contentType: sourceMime,
				cacheControl: MUTABLE_MEDIA_CACHE_CONTROL,
			});
		} catch (error) {
			return handleError(error, "Failed to replace media", "MEDIA_REPLACE_ERROR");
		}

		const result = await emdash.handleMediaReplaceMetadata(id, media.storageKey, {
			size: file.size,
			width: image.width,
			height: image.height,
			contentHash,
		});
		if (!result.success) return unwrapResult(result);

		return apiSuccess({
			item: {
				...result.data.item,
				url: `/_emdash/api/media/file/${result.data.item.storageKey}`,
			},
		});
	} catch (error) {
		return handleError(error, "Failed to replace media", "MEDIA_REPLACE_ERROR");
	}
};
