import { sql, type Kysely, type RawBuilder } from "kysely";

import {
	contentProtectionSchema,
	protectedProjection,
	type ContentProtection,
} from "../../content/protection.js";
import { invalidateCollectionCache } from "../../object-cache/index.js";
import { prepareVisibilityRevBump } from "../../page-cache/state.js";
import { executeAtomicBatchIfSupported } from "../dialect-helpers.js";
import { withTransaction } from "../transaction.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import type { Database, ProtectedContentTable } from "../types.js";
import type { ContentItem, ContentSeoInput } from "./types.js";

/** Private storage. Callers must authorize before hydrating a response. */
export class ProtectedContentRepository {
	constructor(private db: Kysely<Database>) {}

	async find(collection: string, contentId: string): Promise<ProtectedContentTable | undefined> {
		try {
			return await this.db
				.selectFrom("_emdash_protected_content")
				.selectAll()
				.where("collection", "=", collection)
				.where("content_id", "=", contentId)
				.executeTakeFirst();
		} catch (error) {
			if (isMissingTableError(error)) return undefined;
			throw error;
		}
	}

	prepareCreate(
		collection: string,
		contentId: string,
		protection: ContentProtection,
		data: Record<string, unknown>,
	): RawBuilder<unknown> {
		const validated = contentProtectionSchema.parse(protection);
		return sql`INSERT INTO _emdash_protected_content (collection, content_id, credential_version, verifier, data, seo)
			VALUES (${collection}, ${contentId}, 1, ${JSON.stringify(validated.verifier)}, ${JSON.stringify(data)}, NULL)`;
	}

	async create(
		collection: string,
		contentId: string,
		protection: ContentProtection,
		data: Record<string, unknown>,
	): Promise<void> {
		const queries = [
			this.prepareCreate(collection, contentId, protection, data),
			prepareVisibilityRevBump(),
		];
		const batched = await executeAtomicBatchIfSupported(this.db, queries);
		if (!batched) {
			await withTransaction(this.db, async (trx) => {
				for (const query of queries) await query.execute(trx);
			});
		}
	}

	async project(
		collection: string,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const projection = protectedProjection(data);
		const fields = await this.db
			.selectFrom("_emdash_fields as field")
			.innerJoin("_emdash_collections as collection", "collection.id", "field.collection_id")
			.select(["field.slug", "field.required", "field.type", "field.column_type"])
			.where("collection.slug", "=", collection)
			.execute();
		// Match the registry's empty SQL defaults, never a content-valued custom default.
		for (const field of fields) {
			if (projection[field.slug] !== null || (!field.required && field.type !== "blocks")) continue;
			projection[field.slug] =
				field.type === "blocks"
					? []
					: field.column_type === "INTEGER" || field.column_type === "REAL"
						? 0
						: field.column_type === "JSON"
							? "null"
							: "";
		}
		return projection;
	}

	async readData(
		item: Pick<ContentItem, "type" | "id" | "liveRevisionId" | "draftRevisionId">,
		draft = false,
	): Promise<Record<string, unknown> | undefined> {
		const row = await this.find(item.type, item.id);
		if (!row) return undefined;
		const revisionId = (draft ? item.draftRevisionId : null) ?? item.liveRevisionId;
		if (revisionId) {
			const revision = await this.db
				.selectFrom("_emdash_protected_revisions")
				.select("data")
				.where("collection", "=", item.type)
				.where("content_id", "=", item.id)
				.where("revision_id", "=", revisionId)
				.executeTakeFirst();
			if (revision) return JSON.parse(revision.data);
		}
		return JSON.parse(row.data);
	}

	async readRevision(
		revisionId: string,
		collection: string,
		contentId: string,
	): Promise<Record<string, unknown> | undefined> {
		const row = await this.db
			.selectFrom("_emdash_protected_revisions")
			.select("data")
			.where("revision_id", "=", revisionId)
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.executeTakeFirst();
		return row ? JSON.parse(row.data) : undefined;
	}

	/** Join private writes to the owner's atomic content mutation and its success fence. */
	async prepareWrite(
		item: ContentItem,
		patch: Record<string, unknown>,
		applied: RawBuilder<boolean>,
	): Promise<RawBuilder<unknown>[] | undefined> {
		const base = await this.readData(item);
		if (!base) return undefined;
		const data = JSON.stringify({ ...base, ...patch });
		return [
			sql`UPDATE _emdash_protected_content SET data = ${data}
				WHERE collection = ${item.type} AND content_id = ${item.id} AND ${applied}
				RETURNING content_id`,
			sql`UPDATE _emdash_protected_revisions SET data = ${data}
				WHERE revision_id = ${item.liveRevisionId} AND collection = ${item.type} AND content_id = ${item.id} AND ${applied}`,
		];
	}

	async stage(
		collection: string,
		contentId: string,
		revisionId: string,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!(await this.find(collection, contentId))) return data;
		await this.db
			.insertInto("_emdash_protected_revisions")
			.values({
				collection,
				content_id: contentId,
				revision_id: revisionId,
				data: JSON.stringify(data),
			})
			.execute();
		return this.project(collection, data);
	}

	async pruneRevisions(collection: string, contentId: string): Promise<void> {
		if (!(await this.find(collection, contentId))) return;
		await this.db
			.deleteFrom("_emdash_protected_revisions")
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.where("revision_id", "not in", this.db.selectFrom("revisions").select("id"))
			.execute();
	}

	async delete(collection: string, contentId: string): Promise<void> {
		if (!(await this.find(collection, contentId))) return;
		await this.db
			.deleteFrom("_emdash_protected_revisions")
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.execute();
		await this.db
			.deleteFrom("_emdash_protected_content")
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.execute();
	}

	async writeSeo(
		collection: string,
		contentId: string,
		patch: ContentSeoInput,
		onlyAbsent = false,
	): Promise<boolean | null> {
		const row = await this.find(collection, contentId);
		if (!row) return null;
		if (onlyAbsent && row.seo !== null) return false;
		const seo = JSON.stringify({ ...(row.seo ? JSON.parse(row.seo) : {}), ...patch });
		await this.db
			.updateTable("_emdash_protected_content")
			.set({ seo })
			.where("collection", "=", collection)
			.where("content_id", "=", contentId)
			.execute();
		invalidateCollectionCache(collection);
		return true;
	}
}
