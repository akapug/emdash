import { z } from "zod";

/** Versioned separately from the WXR upload API; old runtimes must refuse sync. */
export const IMPORT_SYNC_VERSION = 1;

const identity = z.string().trim().min(1);

export const importSyncGrantCreateSchema = z
	.object({ sourceSite: z.url(), bindingId: identity, actorId: identity })
	.strict();
export const importSyncGrantRevokeSchema = z.object({ id: identity }).strict();
export type ImportSyncGrantCreateRequest = z.infer<typeof importSyncGrantCreateSchema>;
export type ImportSyncGrantRevokeRequest = z.infer<typeof importSyncGrantRevokeSchema>;

export const importSyncRequestSchema = z
	.object({
		version: z.literal(IMPORT_SYNC_VERSION),
		operationId: identity,
		grant: z
			.object({
				id: identity,
				bindingId: identity,
				generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			})
			.strict(),
		source: z
			.object({
				site: z.url(),
				type: z.enum(["page", "post"]),
				id: identity,
			})
			.strict(),
		collection: z.string().regex(/^[a-z][a-z0-9_]*$/),
		locale: identity,
		sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		entryId: identity.optional(),
		expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
		slug: identity,
		data: z.record(z.string(), z.unknown()),
		createdAt: z.iso.datetime().optional(),
		publishedAt: z.iso.datetime().optional(),
	})
	.strict()
	.refine((value) => (value.entryId === undefined) === (value.expectedVersion === undefined), {
		message: "Updates require both entryId and expectedVersion",
	});

export type ImportSyncRequest = z.infer<typeof importSyncRequestSchema>;

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Bind replays to the full accepted input, not plugin-normalized output or wall time. */
export async function hashImportSyncRequest(
	request: ImportSyncRequest,
	authorId: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson({ request, authorId }));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
