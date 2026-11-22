/**
 * One-click backup download
 *
 * GET /_emdash/api/settings/backups/export — generate a fresh backup and
 * stream it as a JSON download. Read-only (nothing is stored), so GET is
 * appropriate despite the cost of generating the payload.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError } from "#api/error.js";
import { ErrorCode } from "#api/errors.js";
import { archiveNameForDate, generateBackupJson } from "#api/handlers/backup.js";
import { exportZipFilename, streamSiteExportZip } from "#api/handlers/site-export.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "backups:manage");
	if (denied) return denied;

	const url = new URL(request.url);
	const format = url.searchParams.get("format");

	try {
		if (format === "zip") {
			const now = new Date();
			const stream = await streamSiteExportZip({
				db: emdash.db,
				storage: emdash.storage,
				siteUrl: url.origin,
				now,
			});
			return new Response(stream, {
				status: 200,
				headers: {
					"Content-Type": "application/zip",
					"Content-Disposition": `attachment; filename="${exportZipFilename(now)}"`,
					// Session-specific full-content export — never cacheable anywhere.
					"Cache-Control": "private, no-store",
					"X-Content-Type-Options": "nosniff",
				},
			});
		}

		const json = await generateBackupJson(emdash.db);
		return new Response(json, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Content-Disposition": `attachment; filename="${archiveNameForDate(new Date())}"`,
				// Session-specific full-content export — never cacheable anywhere.
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		return handleError(error, "Failed to generate backup", ErrorCode.BACKUP_EXPORT_ERROR);
	}
};
