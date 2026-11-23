import { SqliteAdapter, sql, type Kysely, type RawBuilder } from "kysely";

import { isMissingTableError } from "../utils/db-errors.js";
import { tableExists } from "./dialect-helpers.js";
import { validateIdentifier } from "./validate.js";

interface ImportTrigger {
	name: string;
	statement: RawBuilder<unknown>;
}

type Mutation = "INSERT" | "UPDATE" | "DELETE";
type TriggerRow = "old" | "new";

/**
 * How a trigger names the tables it reads. SQLite's ALTER TABLE RENAME rewrites
 * every reference to the renamed table as a quoted identifier, so only the
 * quoted form reads back unchanged after a rename round trip (an interrupted
 * rebuild restored by 071, say). Installs before that wrote bare names, and
 * those still count as installed.
 */
type TriggerForm = "quoted" | "bare";

function tableNamer(form: TriggerForm): (name: string) => RawBuilder<unknown> {
	return (name) => (form === "quoted" ? sql.ref(name) : sql.raw(name));
}

export function supportsImportBaselineDialect<DB>(db: Kysely<DB>): boolean {
	return db.getExecutor().adapter instanceof SqliteAdapter;
}

function originalPinTrigger(form: TriggerForm = "quoted"): ImportTrigger {
	const t = tableNamer(form);
	const name = "emdash_import_original_pin";
	return {
		name,
		statement: sql`CREATE TRIGGER IF NOT EXISTS ${sql.ref(name)}
			BEFORE DELETE ON ${t("revisions")}
			WHEN EXISTS (
				SELECT 1 FROM ${t("_emdash_import_baselines")} WHERE original_revision_id = old.id
			)
			BEGIN
				SELECT RAISE(IGNORE);
			END`,
	};
}

function collectionTriggers(collection: string, form: TriggerForm = "quoted"): ImportTrigger[] {
	validateIdentifier(collection, "collection");
	const t = tableNamer(form);
	const baselines = t("_emdash_import_baselines");
	const table = `ec_${collection}`;
	const slug = sql.lit(collection);
	const triggers: ImportTrigger[] = [];

	function add(
		target: string,
		label: string,
		events: readonly Mutation[],
		match: (row: TriggerRow) => RawBuilder<unknown>,
	): void {
		for (const event of events) {
			const rows: TriggerRow[] =
				event === "UPDATE" ? ["old", "new"] : [event === "DELETE" ? "old" : "new"];
			const name = `emdash_import_${collection}_${label}_${event.toLowerCase()}`;
			triggers.push({
				name,
				statement: sql`CREATE TRIGGER IF NOT EXISTS ${sql.ref(name)}
					AFTER ${sql.raw(event)} ON ${sql.ref(target)}
					BEGIN
						UPDATE ${baselines} SET customer_owned = 1
						WHERE collection = ${slug} AND customer_owned = 0
						AND (${sql.join(rows.map(match), sql` OR `)});
					END`,
			});
		}
	}

	function bylineMatch(group: RawBuilder<unknown>): RawBuilder<unknown> {
		return sql`(
			EXISTS (SELECT 1 FROM ${t("_emdash_content_bylines")} AS credit
				WHERE credit.collection_slug = ${slug}
				AND credit.content_id = ${baselines}.entry_id
				AND credit.byline_id = ${group})
			OR EXISTS (SELECT 1 FROM ${sql.ref(table)} AS content
				WHERE content.id = ${baselines}.entry_id
				AND content.primary_byline_id = ${group})
		)`;
	}

	const mutations: readonly Mutation[] = ["INSERT", "UPDATE", "DELETE"];
	add(table, "content", ["UPDATE", "DELETE"], (row) => sql`entry_id = ${sql.ref(`${row}.id`)}`);
	add(
		"_emdash_seo",
		"seo",
		mutations,
		(row) => sql`${sql.ref(`${row}.collection`)} = ${slug}
		AND entry_id = ${sql.ref(`${row}.content_id`)}`,
	);
	add(
		"_emdash_content_bylines",
		"credits",
		mutations,
		(row) => sql`${sql.ref(`${row}.collection_slug`)} = ${slug}
		AND entry_id = ${sql.ref(`${row}.content_id`)}`,
	);
	add(
		"content_taxonomies",
		"assignments",
		mutations,
		(row) => sql`${sql.ref(`${row}.collection`)} = ${slug}
		AND EXISTS (SELECT 1 FROM ${sql.ref(table)} AS content
			WHERE content.id = ${baselines}.entry_id
			AND content.translation_group = ${sql.ref(`${row}.entry_id`)})`,
	);
	add(
		"taxonomies",
		"terms",
		mutations,
		(row) => sql`EXISTS (
		SELECT 1 FROM ${t("content_taxonomies")} AS assignment
		JOIN ${sql.ref(table)} AS content ON content.translation_group = assignment.entry_id
		WHERE assignment.collection = ${slug}
		AND content.id = ${baselines}.entry_id
		AND assignment.taxonomy_id = COALESCE(${sql.ref(`${row}.translation_group`)}, ${sql.ref(`${row}.id`)})
	)`,
	);
	// A reference edge belongs to both endpoints, so either side becomes customer-owned.
	add(
		"_emdash_content_references",
		"references",
		mutations,
		(row) => sql`EXISTS (SELECT 1 FROM ${sql.ref(table)} AS content
			WHERE content.id = ${baselines}.entry_id
			AND content.translation_group IN (${sql.ref(`${row}.parent_group`)}, ${sql.ref(`${row}.child_group`)}))`,
	);
	add("_emdash_bylines", "bylines", mutations, (row) =>
		bylineMatch(sql`COALESCE(${sql.ref(`${row}.translation_group`)}, ${sql.ref(`${row}.id`)})`),
	);
	add("_emdash_byline_field_values", "byline_values", mutations, (row) =>
		bylineMatch(sql`(SELECT COALESCE(translation_group, id) FROM ${t("_emdash_bylines")}
			WHERE id = ${sql.ref(`${row}.byline_id`)})`),
	);
	add("_emdash_byline_field_group_values", "byline_group_values", mutations, (row) =>
		bylineMatch(sql`${sql.ref(`${row}.translation_group`)}`),
	);
	return triggers;
}

/** A trigger as installed now, and as an earlier install wrote it (see TriggerForm). */
interface ExpectedTrigger extends ImportTrigger {
	bare: ImportTrigger;
}

function expectTriggers(build: (form: TriggerForm) => ImportTrigger[]): ExpectedTrigger[] {
	const bare = build("bare");
	return build("quoted").map((trigger, index) => ({ ...trigger, bare: bare[index] }));
}

/**
 * The stored SQL that counts as this trigger. Compiling passes through the
 * connection's plugins, which count it as a query, so callers compile only what
 * they compare; the bare form is never executed and compiles without them.
 */
function acceptedSql<DB>(db: Kysely<DB>, trigger: ExpectedTrigger): [quoted: string, bare: string] {
	return [
		normalizeTriggerSql(trigger.statement.compile(db).sql),
		normalizeTriggerSql(trigger.bare.statement.compile(db.withoutPlugins()).sql),
	];
}

function isAccepted<DB>(db: Kysely<DB>, trigger: ExpectedTrigger, stored: string): boolean {
	return acceptedSql(db, trigger).includes(normalizeTriggerSql(stored));
}

export async function installImportBaselinePinTrigger<DB>(db: Kysely<DB>): Promise<void> {
	if (!supportsImportBaselineDialect(db)) return;
	const [trigger] = expectTriggers((form) => [originalPinTrigger(form)]);
	const { rows } = await sql<{ sql: string }>`SELECT sql FROM sqlite_master
		WHERE type = 'trigger' AND name = ${trigger.name}`.execute(db);
	if (rows[0] && !isAccepted(db, trigger, rows[0].sql)) {
		throw new Error("Import baseline original-pin trigger does not match the supported schema");
	}
	if (rows.length === 0) {
		await sql`UPDATE _emdash_import_baselines SET customer_owned = 1`.execute(db);
	}
	await trigger.statement.execute(db);
}

/**
 * What installing a new collection's triggers costs: one schema read, the gap
 * update and one CREATE per trigger. Schema creation pays it once per collection.
 */
export const IMPORT_BASELINE_FRESH_INSTALL_QUERIES = collectionTriggers("collection").length + 2;

export async function installImportBaselineCollectionTriggers<DB>(
	db: Kysely<DB>,
	collection: string,
): Promise<void> {
	if (!supportsImportBaselineDialect(db)) return;
	const triggers = expectTriggers((form) => collectionTriggers(collection, form));
	const table = `ec_${collection}`;
	// One schema read answers every question the install asks.
	const { rows } = await sql<{ type: string; name: string; sql: string }>`SELECT type, name, sql
		FROM sqlite_master
		WHERE (type = 'table' AND name IN ('_emdash_import_baselines', ${table}))
		OR (type = 'trigger' AND name IN (${sql.join(triggers.map((trigger) => sql`${trigger.name}`))}))`.execute(
		db,
	);
	const tables = new Set(rows.filter((row) => row.type === "table").map((row) => row.name));
	if (!tables.has("_emdash_import_baselines")) return;
	// A registry row can outlive its content table (an interrupted D1 delete drops the
	// table first). Its triggers cannot be created, so the collection stays unknown.
	if (!tables.has(table)) {
		await sql`UPDATE _emdash_import_baselines SET customer_owned = 1
			WHERE collection = ${collection}`.execute(db);
		return;
	}
	const installed = new Map(
		rows.filter((row) => row.type === "trigger").map((row) => [row.name, row.sql]),
	);
	if (installed.size !== triggers.length) {
		// A gap in the witness cannot prove that existing baselines stayed untouched.
		await sql`UPDATE _emdash_import_baselines SET customer_owned = 1
			WHERE collection = ${collection}`.execute(db);
	}
	for (const trigger of triggers) {
		const statement = installed.get(trigger.name);
		if (statement !== undefined && !isAccepted(db, trigger, statement)) {
			throw new Error(
				`Import baseline trigger ${trigger.name} does not match the supported schema`,
			);
		}
	}
	for (const trigger of triggers) {
		// A matching trigger is already in place; CREATE only what is missing.
		if (installed.has(trigger.name)) continue;
		// oxlint-disable-next-line no-await-in-loop -- D1 migration statements must be restartable individually
		await trigger.statement.execute(db);
	}
}

export async function removeImportBaselineCollectionTriggers<DB>(
	db: Kysely<DB>,
	collection: string,
): Promise<void> {
	if (!supportsImportBaselineDialect(db)) return;
	if (!(await tableExists(db, "_emdash_import_baselines"))) return;
	await sql`UPDATE _emdash_import_baselines SET customer_owned = 1
		WHERE collection = ${collection}`.execute(db);
	for (const trigger of collectionTriggers(collection)) {
		// oxlint-disable-next-line no-await-in-loop -- remove cross-table references before dropping a content table
		await sql`DROP TRIGGER IF EXISTS ${sql.ref(trigger.name)}`.execute(db);
	}
}

/** With translationGroup enabled, entryId is the already resolved content translation group. */
export async function markImportBaselineCustomerOwned<DB>(
	db: Kysely<DB>,
	collection: string,
	entryId: string,
	options: { translationGroup?: boolean } = {},
): Promise<void> {
	if (!supportsImportBaselineDialect(db)) return;
	validateIdentifier(collection, "collection");
	const entryMatch = options.translationGroup
		? sql`EXISTS (SELECT 1 FROM ${sql.ref(`ec_${collection}`)} AS content
			WHERE content.id = _emdash_import_baselines.entry_id
			AND content.translation_group = ${entryId})`
		: sql`entry_id = ${entryId}`;
	try {
		await sql`UPDATE _emdash_import_baselines SET customer_owned = 1
			WHERE collection = ${collection} AND customer_owned = 0 AND ${entryMatch}`.execute(db);
	} catch (error) {
		if (
			isMissingTableError(error) &&
			error instanceof Error &&
			error.message.includes("_emdash_import_baselines")
		)
			return;
		throw error;
	}
}

const IF_NOT_EXISTS = /\bIF NOT EXISTS\s+/i;

function normalizeTriggerSql(statement: string): string {
	return statement.replace(IF_NOT_EXISTS, "");
}

/** Embed this witness in the first importer operation guard, inside its atomic unit. */
export function importBaselineTriggerWitness<DB>(
	db: Kysely<DB>,
	collection: string,
): RawBuilder<boolean> {
	if (!supportsImportBaselineDialect(db)) return sql<boolean>`0`;
	const expected = expectTriggers((form) => [
		originalPinTrigger(form),
		...collectionTriggers(collection, form),
	]).map((trigger) => {
		const [quoted, bare] = acceptedSql(db, trigger);
		return { name: trigger.name, quoted, bare };
	});
	// One JSON binding keeps the guard below D1's parameter ceiling.
	return sql<boolean>`(
		EXISTS (SELECT 1 FROM _emdash_collections WHERE slug = ${collection})
		AND 3 = (SELECT count(*) FROM sqlite_master WHERE type = 'table'
			AND name IN ('_emdash_import_baselines', '_emdash_import_operations', ${`ec_${collection}`}))
		AND NOT EXISTS (
			SELECT 1 FROM json_each(${JSON.stringify(expected)}) AS expected
			LEFT JOIN sqlite_master AS installed
				ON installed.type = 'trigger'
				AND installed.name = json_extract(expected.value, '$.name')
			WHERE installed.sql IS NULL OR installed.sql NOT IN (
				json_extract(expected.value, '$.quoted'), json_extract(expected.value, '$.bare'))
		)
	)`;
}

/** Import capability checks run on the write/admin path, never during anonymous rendering. */
export async function hasImportBaselineTriggers<DB>(
	db: Kysely<DB>,
	collection: string,
): Promise<boolean> {
	if (!supportsImportBaselineDialect(db)) return false;
	try {
		const { rows } = await sql<{
			ready: number;
		}>`SELECT ${importBaselineTriggerWitness(db, collection)} AS ready`.execute(db);
		return rows[0]?.ready === 1;
	} catch (error) {
		if (isMissingTableError(error)) return false;
		throw error;
	}
}
