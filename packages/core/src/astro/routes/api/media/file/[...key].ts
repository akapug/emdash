/**
 * Serve uploaded media files
 *
 * GET /_emdash/api/media/file/:key - Serve file from storage
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";
import { IMMUTABLE_IMAGE_CACHE, MUTABLE_MEDIA_CACHE_CONTROL } from "#media/image-endpoint.js";

import { resolveVariantForRequest } from "../../../../../media/variant-serve.js";
import { parseByteRange } from "../../../../../storage/byte-range.js";
import type { DownloadResult, RangedDownloadResult } from "../../../../../storage/types.js";
import { isRefusedStorageKey } from "../../../../../transfer/staging/keys.js";

export const prerender = false;

const MAX_KEY_DECODES = 3;

/**
 * Whether a key is, or percent-decodes to, a key this route must refuse.
 * Every decoding layer is checked because storage backends differ in whether
 * they decode keys; a key that is still encoded after the last layer, or
 * does not decode, is refused.
 */
function isPrivateMediaKey(key: string): boolean {
	let candidate = key;
	for (let layer = 0; layer <= MAX_KEY_DECODES; layer++) {
		if (isRefusedStorageKey(candidate)) return true;
		let decoded: string;
		try {
			decoded = decodeURIComponent(candidate);
		} catch {
			return true;
		}
		if (decoded === candidate) return false;
		candidate = decoded;
	}
	return true;
}

/**
 * Content types that are safe to display inline (simple raster/vector images, video, audio).
 * Everything else gets Content-Disposition: attachment to prevent script execution.
 */
const SAFE_INLINE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/x-icon",
	"video/mp4",
	"video/webm",
	"audio/mpeg",
	"audio/wav",
	"audio/ogg",
]);

function isMissingObject(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "NOT_FOUND";
}

// Sandbox all uploads, including direct navigation to active content types.
const MEDIA_SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy":
		"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
};

export const GET: APIRoute = async ({ params, locals, url, request }) => {
	const { key } = params;
	const { emdash } = locals;

	if (!key) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	// Backup archives and transfer staging share the storage bucket but hold
	// whole-site content; they must never be reachable through this public,
	// unauthenticated route.
	if (isPrivateMediaKey(key)) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	if (!emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage not configured", 500);
	}

	const { db, storage } = emdash;
	try {
		// This route doesn't provide a validator that could satisfy If-Range.
		const range = request.headers.has("if-range")
			? null
			: parseByteRange(request.headers.get("range"));
		const download = (storageKey: string) =>
			range && storage.downloadRange
				? storage.downloadRange(storageKey, range)
				: storage.download(storageKey);
		const variant = db ? await resolveVariantForRequest(db, key, url.searchParams.get("w")) : null;
		let result: DownloadResult | RangedDownloadResult | undefined;
		if (variant && variant.storageKey !== key) {
			try {
				result = await download(variant.storageKey);
			} catch (error) {
				// A stale srcset can outlive its variant object, but a storage failure is not a miss.
				if (!isMissingObject(error)) throw error;
			}
		}
		if (!result) {
			try {
				result = await download(key);
			} catch (error) {
				// Older adapters may report a missing original without a storage error code.
				if (
					isMissingObject(error) ||
					(error instanceof Error &&
						!("code" in error) &&
						(error.message === "File not found" ||
							error.message === `File not found: ${key}` ||
							error.message === "NOT_FOUND"))
				) {
					return apiError("NOT_FOUND", "File not found", 404);
				}
				throw error;
			}
		}

		const headers: Record<string, string> = { ...MEDIA_SECURITY_HEADERS };
		if (storage.downloadRange) headers["Accept-Ranges"] = "bytes";
		if ("kind" in result && result.kind === "unsatisfiable") {
			headers["Content-Range"] = `bytes */${result.size}`;
			headers["Cache-Control"] = "no-store";
			return new Response(null, { status: 416, headers });
		}

		headers["Content-Type"] = result.contentType;
		headers["Cache-Control"] = result.contentType.startsWith("image/")
			? MUTABLE_MEDIA_CACHE_CONTROL
			: IMMUTABLE_IMAGE_CACHE;
		let status = 200;
		if ("kind" in result) {
			status = 206;
			headers["Content-Range"] = `bytes ${result.start}-${result.end}/${result.size}`;
			headers["Content-Length"] = String(result.end - result.start + 1);
		} else if (result.size) {
			headers["Content-Length"] = String(result.size);
		}

		// Safe image/media types can render inline; everything else (SVG, PDF,
		// HTML, JS, etc.) must be downloaded to prevent stored XSS.
		if (SAFE_INLINE_TYPES.has(result.contentType)) {
			headers["Content-Disposition"] = "inline";
		} else {
			headers["Content-Disposition"] = "attachment";
		}

		return new Response(result.body, { status, headers });
	} catch (error) {
		return handleError(error, "Failed to serve file", "FILE_SERVE_ERROR");
	}
};
