/**
 * Serve uploaded media files
 *
 * GET /_emdash/api/media/file/:key - Serve file from storage
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";
import { IMMUTABLE_IMAGE_CACHE, MUTABLE_MEDIA_CACHE_CONTROL } from "#media/image-endpoint.js";

import { resolveVariantForRequest } from "../../../../../media/variant-serve.js";
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

export const GET: APIRoute = async ({ params, locals, url }) => {
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

	// W3: `?w=` on a parent's public URL asks for a stored size. Resolved BEFORE the
	// download, and only to a committed variant of the CURRENT parent — a width with
	// nothing behind it serves the original, which is what makes a stale srcset safe.
	const variant = emdash.db
		? await resolveVariantForRequest(emdash.db, key, url.searchParams.get("w"))
		: null;
	let storageKey = variant?.storageKey ?? key;

	// A COMMITTED ROW WHOSE OBJECT IS MISSING SERVES THE ORIGINAL. The row and the object
	// are two writes; a crash, a cleanup sweep, or a storage fault can leave the row
	// naming bytes that are gone. Answering 5xx there would break the image on a page for
	// a case the parent can satisfy — so the fallback is the parent, which is the same
	// picture at full size.
	let result: Awaited<ReturnType<typeof emdash.storage.download>>;
	try {
		result = await emdash.storage.download(storageKey);
	} catch (error) {
		if (storageKey === key) throw error;
		storageKey = key;
		result = await emdash.storage.download(key);
	}

	try {
		const headers: Record<string, string> = {
			"Content-Type": variant?.contentType ?? result.contentType,
			"Cache-Control": result.contentType.startsWith("image/")
				? MUTABLE_MEDIA_CACHE_CONTROL
				: IMMUTABLE_IMAGE_CACHE,
			"X-Content-Type-Options": "nosniff",
			// Sandbox CSP on all user-uploaded content — prevents script execution
			// even for SVGs navigated to directly or content types that support scripting.
			"Content-Security-Policy":
				"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
		};

		if (result.size) {
			headers["Content-Length"] = String(result.size);
		}

		// Safe image/media types can render inline; everything else (SVG, PDF,
		// HTML, JS, etc.) must be downloaded to prevent stored XSS.
		if (SAFE_INLINE_TYPES.has(result.contentType)) {
			headers["Content-Disposition"] = "inline";
		} else {
			headers["Content-Disposition"] = "attachment";
		}

		return new Response(result.body, { status: 200, headers });
	} catch (error) {
		// Check if it's a "not found" error
		if (
			error instanceof Error &&
			(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
		) {
			return apiError("NOT_FOUND", "File not found", 404);
		}
		return handleError(error, "Failed to serve file", "FILE_SERVE_ERROR");
	}
};
