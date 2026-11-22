/**
 * Signed, time-limited media download for overflow files in site exports.
 *
 * GET /_emdash/api/settings/backups/media/:key?exp=<unix>&sig=<hmac>
 *
 * Authenticated by an HMAC-SHA256 signature minted with this site's own
 * `previewSecret` (domain-separated via `export-media:`). Refuses private
 * prefixes (`backups/`, `transfers/`), path traversal, invalid or expired
 * signatures, and keys not verified against this site's secret.
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";
import { ErrorCode } from "#api/errors.js";
import { isSafeExportMediaKey, verifyExportMediaSignature } from "#api/handlers/site-export.js";
import { resolveSecrets } from "#config/secrets.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
	const { key } = params;
	const { emdash } = locals;

	if (!key || !isSafeExportMediaKey(key)) {
		return apiError(ErrorCode.NOT_FOUND, "File not found", 404);
	}

	if (!emdash?.db || !emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage is not configured", 500);
	}

	const url = new URL(request.url);
	const exp = url.searchParams.get("exp") ?? "";
	const sig = url.searchParams.get("sig") ?? "";

	try {
		const secrets = await resolveSecrets({ db: emdash.db });
		const valid = await verifyExportMediaSignature({
			key,
			exp,
			sig,
			secret: secrets.previewSecret,
		});
		if (!valid) {
			return apiError(ErrorCode.FORBIDDEN, "Invalid or expired export media signature", 403);
		}

		const downloaded = await emdash.storage.download(key);
		const filename = key.split("/").pop() ?? "file";
		return new Response(downloaded.body, {
			status: 200,
			headers: {
				"Content-Type": downloaded.contentType || "application/octet-stream",
				"Content-Length": String(downloaded.size),
				"Content-Disposition": `attachment; filename="${filename.replaceAll('"', "_")}"`,
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		return handleError(error, "Failed to download export media", ErrorCode.NOT_FOUND);
	}
};
