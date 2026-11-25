/**
 * Media CRUD handlers
 */

import type { Kysely } from "kysely";

import {
	MediaVariantRepository,
	variantPublicationId,
	type ExactVariantSkipReason,
	type ExactVariantTarget,
} from "../../database/repositories/media-variants.js";
import { MediaRepository, type MediaItem } from "../../database/repositories/media.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { isValidFocalPointUpdate, type FocalPointUpdate } from "../../media/focal-point.js";
import { removeUploadAttempt } from "../../media/upload-attempts.js";
import type { Storage } from "../../storage/types.js";
import { MEDIA_VARIANT_STORAGE_PREFIX } from "../../transfer/staging/keys.js";
import type { ApiResult } from "../types.js";

const FOREIGN_KEY_VIOLATION_RE = /foreign key constraint failed/i;

export interface MediaListResponse {
	items: MediaItem[];
	nextCursor?: string;
	totalCount?: number;
}

export interface MediaResponse {
	item: MediaItem;
}

/**
 * List media items
 */
export async function handleMediaList(
	db: Kysely<Database>,
	params: {
		cursor?: string;
		page?: number;
		limit?: number;
		mimeType?: string | readonly string[];
		q?: string;
		folderId?: string | null;
	},
): Promise<ApiResult<MediaListResponse>> {
	try {
		if (params.page !== undefined) {
			const limit = Math.min(params.limit || 50, 100);
			const offset = (params.page - 1) * limit;
			if (
				params.cursor !== undefined ||
				!Number.isSafeInteger(params.page) ||
				params.page < 1 ||
				!Number.isSafeInteger(offset)
			) {
				return {
					success: false,
					error: { code: "VALIDATION_ERROR", message: "Invalid media page" },
				};
			}

			const repo = new MediaRepository(db);
			const result = await repo.findPage({
				page: params.page,
				limit,
				mimeType: params.mimeType,
				q: params.q,
				folderId: params.folderId,
			});
			return { success: true, data: result };
		}

		const repo = new MediaRepository(db);
		const result = await repo.findMany({
			cursor: params.cursor,
			limit: Math.min(params.limit || 50, 100),
			mimeType: params.mimeType,
			q: params.q,
			folderId: params.folderId,
		});

		return {
			success: true,
			data: {
				items: result.items,
				nextCursor: result.nextCursor,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		return {
			success: false,
			error: {
				code: "MEDIA_LIST_ERROR",
				message: "Failed to list media",
			},
		};
	}
}

/**
 * Get single media item
 */
export async function handleMediaGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<MediaResponse>> {
	try {
		const repo = new MediaRepository(db);
		const item = await repo.findById(id);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Media item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_GET_ERROR",
				message: "Failed to get media",
			},
		};
	}
}

/**
 * Create media item (after file upload)
 */
export async function handleMediaCreate(
	db: Kysely<Database>,
	input: {
		filename: string;
		mimeType: string;
		size?: number;
		width?: number;
		height?: number;
		alt?: string;
		storageKey: string;
		contentHash?: string;
		blurhash?: string;
		dominantColor?: string;
		authorId?: string;
		folderId?: string | null;
	},
): Promise<ApiResult<MediaResponse>> {
	try {
		const repo = new MediaRepository(db);
		const item = await repo.create(input);

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_CREATE_ERROR",
				message: "Failed to create media",
			},
		};
	}
}

/**
 * Confirm an upload minted by the signed upload URL endpoint.
 *
 * The storage key must belong to a pending media row created for the same
 * user; arbitrary keys never reach storage this way.
 */
export async function handleMediaRegisterUpload(
	db: Kysely<Database>,
	storage: Storage,
	input: {
		storageKey: string;
		authorId?: string;
	},
): Promise<ApiResult<MediaResponse>> {
	const invalidKey: ApiResult<never> = {
		success: false,
		error: {
			code: "INVALID_STORAGE_KEY",
			message:
				"storageKey does not match a pending upload created for this user; request a signed upload URL first",
		},
	};
	try {
		const repo = new MediaRepository(db);
		const pending = await repo.findPendingByStorageKey(input.storageKey);
		if (!pending) return invalidKey;
		if ((pending.authorId ?? null) !== (input.authorId ?? null)) return invalidKey;
		if (pending.size === null) {
			return {
				success: false,
				error: {
					code: "INVALID_STATE",
					message: "Pending upload has no expected size",
				},
			};
		}
		if (!(await storage.exists(input.storageKey))) {
			return {
				success: false,
				error: { code: "FILE_NOT_FOUND", message: "File was not uploaded to storage" },
			};
		}

		const storedFile = await storage.download(input.storageKey);
		try {
			if (storedFile.size !== pending.size) {
				return {
					success: false,
					error: {
						code: "UPLOAD_SIZE_MISMATCH",
						message: "Stored file size does not match the pending upload",
					},
				};
			}
		} finally {
			try {
				await storedFile.body.cancel();
			} catch (error) {
				console.error("[media] upload confirmation cancellation failed:", error);
			}
		}

		const item = await repo.confirmUpload(pending.id, undefined, input.storageKey);
		if (!item) return invalidKey;
		try {
			await repo.deleteUploadAttempt(input.storageKey);
		} catch (error) {
			console.error("[media] upload attempt cleanup failed:", error);
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_REGISTER_ERROR",
				message: "Failed to register the upload",
			},
		};
	}
}

/**
 * Update media metadata
 */
export async function handleMediaUpdate(
	db: Kysely<Database>,
	id: string,
	input: {
		alt?: string;
		caption?: string;
		width?: number;
		height?: number;
		folderId?: string | null;
	} & FocalPointUpdate,
): Promise<ApiResult<MediaResponse>> {
	if (!isValidFocalPointUpdate(input)) {
		return {
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "focalX and focalY must both be valid numbers or both be null",
			},
		};
	}
	try {
		const repo = new MediaRepository(db);
		const item = await repo.update(id, input);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Media item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (isForeignKeyViolation(error)) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Media folder not found" },
			};
		}
		return {
			success: false,
			error: {
				code: "MEDIA_UPDATE_ERROR",
				message: "Failed to update media",
			},
		};
	}
}

export async function handleMediaReplaceMetadata(
	db: Kysely<Database>,
	id: string,
	expectedStorageKey: string,
	input: { size: number; width: number; height: number; contentHash: string },
): Promise<ApiResult<MediaResponse>> {
	try {
		const repo = new MediaRepository(db);
		const item = await repo.replaceReadyFile(id, expectedStorageKey, input);
		if (!item) {
			return {
				success: false,
				error: {
					code: "MEDIA_REPLACE_METADATA_ERROR",
					message: "Failed to update replaced media metadata",
				},
			};
		}
		return { success: true, data: { item } };
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_REPLACE_METADATA_ERROR",
				message: "Failed to update replaced media metadata",
			},
		};
	}
}

function isForeignKeyViolation(error: unknown): boolean {
	if (error && typeof error === "object") {
		if ("code" in error && error.code === "23503") return true;
	}
	const message = error instanceof Error ? error.message : "";
	if (FOREIGN_KEY_VIOLATION_RE.test(message)) return true;
	return Boolean(
		error && typeof error === "object" && "cause" in error && isForeignKeyViolation(error.cause),
	);
}

function variantConflict(message: string): ApiResult<never> {
	return { success: false, error: { code: "CONFLICT", message } };
}

/** Store one of WordPress's validated sizes under a private, immutable key. */
export async function handleMediaVariantStore(
	db: Kysely<Database>,
	storage: Storage | null,
	input: {
		mediaId: string;
		sizeName: string;
		width: number;
		height: number;
		parentContentHash: string;
		bytes: Uint8Array<ArrayBuffer>;
		contentType: string;
		contentHash: string;
	},
): Promise<
	ApiResult<{
		outcome: "stored" | "replayed";
		width: number;
		height: number;
		contentHash: string;
		publicationId?: string;
	}>
> {
	if (!storage) {
		return { success: false, error: { code: "NO_STORAGE", message: "Storage not configured" } };
	}

	const success = (outcome: "stored" | "replayed", publicationId?: string) => ({
		success: true as const,
		data: {
			outcome,
			width: input.width,
			height: input.height,
			contentHash: input.contentHash,
			...(publicationId ? { publicationId } : {}),
		},
	});
	const slotConflict = "A different variant already owns this slot";
	const changed = "The parent or variant slot changed while this variant was being stored";

	try {
		const parent = await new MediaRepository(db).findById(input.mediaId);
		if (!parent) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Media item not found: ${input.mediaId}` },
			};
		}
		if (parent.status !== "ready") {
			return {
				success: false,
				error: { code: "INVALID_STATE", message: "Only a ready image can receive a variant" },
			};
		}
		if (parent.contentHash !== input.parentContentHash) return variantConflict(changed);

		const repo = new MediaVariantRepository(db);
		const slot = await repo.findSlot(input);
		if (slot) {
			if (slot.contentHash !== input.contentHash) return variantConflict(slotConflict);
			if (await storage.exists(slot.storageKey)) {
				// The parent or key can change while checking storage.
				const current = await repo.findSlot(input);
				return current?.storageKey === slot.storageKey
					? success("replayed")
					: variantConflict(changed);
			}
		}

		const ext = extensionFor(input.contentType);
		const storageKey = `${MEDIA_VARIANT_STORAGE_PREFIX}${crypto.randomUUID()}${ext}`;
		// Do not start a PUT without durable custody. A rejected PUT or an uncertain
		// publication result must not cause us to remove the object or its marker.
		await repo.registerCandidate(storageKey);
		await storage.upload({ key: storageKey, body: input.bytes, contentType: input.contentType });
		const result = await repo.store(
			{ ...input, storageKey, bytes: input.bytes.byteLength },
			slot?.storageKey,
		);
		if (result.outcome !== "conflict") {
			const publicationId =
				result.outcome === "stored" ? await variantPublicationId(result.storageKey) : undefined;
			return success(result.outcome, publicationId);
		}

		// The write definitively lost. Requeue after the PUT, even if an earlier
		// sweep already deleted the pending key and acknowledged its first marker.
		try {
			await repo.retireCandidate(storageKey);
		} catch {
			// The candidate cannot be committed. If the queue is unavailable, deleting
			// it now is safe; failure of both operations remains a server error.
			await storage.delete(storageKey);
		}
		const winner = await repo.findSlot(input);
		if (winner && winner.contentHash !== input.contentHash) return variantConflict(slotConflict);
		if (winner && (await storage.exists(winner.storageKey))) {
			const current = await repo.findSlot(input);
			if (current?.storageKey === winner.storageKey) return success("replayed");
		}
		return variantConflict(changed);
	} catch (error) {
		console.error("[media] variant store failed:", error);
		return {
			success: false,
			error: { code: "MEDIA_VARIANT_STORE_ERROR", message: "Failed to store media variant" },
		};
	}
}

/**
 * Delete stored image variant rows for a parent media item (all widths, or a
 * specific subset). Deletes DB rows only so triggers queue object retirement.
 */
export async function handleMediaVariantDelete(
	db: Kysely<Database>,
	input: {
		mediaId: string;
		widths?: readonly number[];
		parentContentHash?: string;
		currentParentContentHash?: string;
		exact?: readonly ExactVariantTarget[];
	},
): Promise<
	ApiResult<{
		deleted: number;
		removed: Array<{ width: number; contentHash: string }>;
		skipped?: Array<{ width: number; why: ExactVariantSkipReason }>;
	}>
> {
	try {
		const repo = new MediaVariantRepository(db);
		if (input.exact !== undefined && input.parentContentHash !== undefined) {
			const { removed, skipped } = await repo.deleteExact(
				input.mediaId,
				input.parentContentHash,
				input.currentParentContentHash ?? "",
				input.exact,
			);
			return {
				success: true,
				data: { deleted: removed.length, removed, skipped },
			};
		}
		const removed = await repo.deleteForMedia(input.mediaId, input.widths);
		return {
			success: true,
			data: { deleted: removed.length, removed },
		};
	} catch (error) {
		console.error("[media] variant delete failed:", error);
		return {
			success: false,
			error: { code: "MEDIA_VARIANT_DELETE_ERROR", message: "Failed to delete media variants" },
		};
	}
}

/** Delete a media item, then delete or queue cleanup of its stored original. */
export async function handleMediaDelete(
	db: Kysely<Database>,
	id: string,
	storage?: Storage | null,
): Promise<ApiResult<{ deleted: true; storageKey: string; storageDeleted: boolean }>> {
	try {
		const repo = new MediaRepository(db);
		const notFound: ApiResult<never> = {
			success: false,
			error: { code: "NOT_FOUND", message: `Media item not found: ${id}` },
		};

		const media = await repo.findById(id);
		if (!media) return notFound;

		if (storage) await repo.trackStorageKeyForCleanup(media.id, media.storageKey);
		const storageKey = await repo.deleteWithStorageKey(id);
		if (!storageKey) return notFound;

		let storageDeleted = false;
		if (storage) {
			if (await repo.isStorageKeyReferenced(storageKey)) {
				// A legacy or concurrently-created row still owns this object. Remove
				// the cleanup marker created above so scheduled cleanup cannot delete it.
				await repo.deleteUploadAttempt(storageKey);
			} else {
				storageDeleted = await removeUploadAttempt(storage, repo, storageKey, {
					allowUntracked: true,
				});
			}
		}

		return {
			success: true,
			data: { deleted: true, storageKey, storageDeleted },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_DELETE_ERROR",
				message: "Failed to delete media",
			},
		};
	}
}

/** The stored object's extension, from the content type we validated. */
function extensionFor(contentType: string): string {
	switch (contentType) {
		case "image/png":
			return ".png";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "image/avif":
			return ".avif";
		default:
			return ".jpg";
	}
}
