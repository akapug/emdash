import { sql, type Kysely, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { currentTimestamp } from "../dialect-helpers.js";
import { supportsImportBaselineDialect } from "../import-baseline-triggers.js";
import type { Database, ImportSyncGrantTable } from "../types.js";

export interface CreateImportSyncGrantInput {
	sourceSite: string;
	bindingId: string;
	actorId: string;
}

export interface ImportSyncGrant extends CreateImportSyncGrantInput {
	id: string;
	generation: number;
	revoked: boolean;
}

function toGrant(row: Selectable<ImportSyncGrantTable>): ImportSyncGrant {
	return {
		id: row.id,
		sourceSite: row.source_site,
		bindingId: row.binding_id,
		actorId: row.actor_id,
		generation: row.generation,
		revoked: row.revoked !== 0,
	};
}

export class ImportSyncGrantRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async create(input: CreateImportSyncGrantInput): Promise<ImportSyncGrant> {
		this.requireSupportedDialect();
		if (
			[input.sourceSite, input.bindingId, input.actorId].some(
				(value) => typeof value !== "string" || !value.trim(),
			)
		) {
			throw new Error("Import sync grants require source site, binding and actor identity");
		}
		const row = await this.db
			.insertInto("_emdash_import_grants")
			.values({
				id: ulid(),
				source_site: input.sourceSite,
				binding_id: input.bindingId,
				actor_id: input.actorId,
			})
			.returningAll()
			.executeTakeFirstOrThrow();
		return toGrant(row);
	}

	async find(id: string): Promise<ImportSyncGrant | null> {
		this.requireSupportedDialect();
		const row = await this.db
			.selectFrom("_emdash_import_grants")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? toGrant(row) : null;
	}

	async revoke(id: string): Promise<ImportSyncGrant | null> {
		this.requireSupportedDialect();
		const row = await this.db
			.updateTable("_emdash_import_grants")
			.set({
				generation: sql`generation + 1`,
				revoked: 1,
				updated_at: currentTimestamp(this.db),
			})
			.where("id", "=", id)
			.where("revoked", "=", 0)
			.returningAll()
			.executeTakeFirst();
		return row ? toGrant(row) : this.find(id);
	}

	private requireSupportedDialect(): void {
		if (!supportsImportBaselineDialect(this.db)) {
			throw new Error("Import sync grants are unavailable for this database dialect");
		}
	}
}
