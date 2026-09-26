/**
 * Settings handlers
 */

import type { Kysely } from "kysely";

import { ContentRepository } from "../../database/repositories/content.js";
import type { Database } from "../../database/types.js";
import { SchemaRegistry } from "../../schema/registry.js";
import {
	getSiteSettingWithDb,
	getSiteSettingsWithDb,
	setSiteSettings,
} from "../../settings/index.js";
import type {
	HomepageEntry,
	HomepageReference,
	SiteSettings,
	SiteSettingsUpdate,
} from "../../settings/types.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";

/**
 * Get all site settings
 */
export async function handleSettingsGet(
	db: Kysely<Database>,
	storage: Storage | null,
): Promise<ApiResult<Partial<SiteSettings>>> {
	try {
		const settings = await getSiteSettingsWithDb(db, storage);
		return { success: true, data: await withHomepageEntry(db, settings) };
	} catch {
		return {
			success: false,
			error: { code: "SETTINGS_READ_ERROR", message: "Failed to get settings" },
		};
	}
}

/**
 * The translation an editor sees for the stored homepage. The reference names
 * a translation group, and the group's original row can be deleted while a
 * translation of it still renders at "/", so the lookup is by group: the
 * original translation when it is published, else a published one, else the
 * first left, whose status then tells the editor why "/" shows no page.
 */
async function resolveHomepageEntry(
	db: Kysely<Database>,
	{ collection, id }: HomepageReference,
): Promise<HomepageEntry | null> {
	if (!(await new SchemaRegistry(db).getCollection(collection))) return null;
	const rows = await new ContentRepository(db).findTranslationStatuses(collection, id);
	const rank = (row: HomepageEntry) =>
		(row.status === "published" ? 0 : 2) + (row.id === id ? 0 : 1);
	const [entry] = rows.toSorted((a, b) => rank(a) - rank(b));
	return entry ?? null;
}

async function withHomepageEntry(
	db: Kysely<Database>,
	settings: Partial<SiteSettings>,
): Promise<Partial<SiteSettings>> {
	if (!settings.homepage) return settings;
	const entry = await resolveHomepageEntry(db, settings.homepage);
	return { ...settings, homepage: { ...settings.homepage, entry } };
}

/**
 * Resolve a homepage reference to the translation group of a live entry, so
 * the stored reference names the entry in every locale. `id` may be the id of
 * any translation or the group itself; `null` means no such entry exists.
 *
 * The stored reference passes unchanged: a client that saves the settings it
 * read must not be refused because the homepage entry was deleted since.
 */
async function resolveHomepageReference(
	db: Kysely<Database>,
	{ collection, id }: HomepageReference,
): Promise<HomepageReference | null> {
	const stored = await getSiteSettingWithDb("homepage", db);
	if (stored?.collection === collection && stored.id === id) return stored;
	if (!(await new SchemaRegistry(db).getCollection(collection))) return null;
	const content = new ContentRepository(db);
	const entry = await content.findById(collection, id);
	if (entry) return { collection, id: entry.translationGroup ?? entry.id };
	const translations = await content.findTranslationIds(collection, id);
	return translations.length > 0 ? { collection, id } : null;
}

/**
 * Update site settings
 */
export async function handleSettingsUpdate(
	db: Kysely<Database>,
	storage: Storage | null,
	input: SiteSettingsUpdate,
): Promise<ApiResult<Partial<SiteSettings>>> {
	try {
		let update = input;
		if (input.homepage) {
			const homepage = await resolveHomepageReference(db, input.homepage);
			if (!homepage) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: `Homepage entry not found: ${input.homepage.collection}/${input.homepage.id}`,
					},
				};
			}
			update = { ...input, homepage };
		}
		await setSiteSettings(update, db);
		const updatedSettings = await getSiteSettingsWithDb(db, storage);
		return { success: true, data: await withHomepageEntry(db, updatedSettings) };
	} catch {
		return {
			success: false,
			error: { code: "SETTINGS_UPDATE_ERROR", message: "Failed to update settings" },
		};
	}
}
