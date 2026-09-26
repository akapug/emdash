/**
 * The settings route saves the site's homepage.
 *
 * A request that names a homepage must either store it or say why not: a 200
 * that drops the field leaves the client nothing to react to.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleContentCreate, handleContentDelete } from "../../../src/api/handlers/content.js";
import { GET, POST } from "../../../src/astro/routes/api/settings.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN = { id: "user_admin", role: Role.ADMIN };

describe("settings route homepage", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownTestDatabase(db);
	});

	function context(request: Request) {
		return {
			request,
			locals: { emdash: { db, storage: null }, user: ADMIN },
		} as unknown as Parameters<typeof POST>[0];
	}

	async function post(body: unknown) {
		const response = await POST(
			context(
				new Request("http://localhost/_emdash/api/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
			),
		);
		return { status: response.status, body: await response.json() };
	}

	/** The entry a GET reports for a published, default-locale page. */
	function live(id: string) {
		return { id, locale: expect.any(String), status: "published" };
	}

	async function get() {
		const response = await GET(context(new Request("http://localhost/_emdash/api/settings")));
		return response.json();
	}

	async function createPage(
		title: string,
		options: { locale?: string; translationOf?: string; status?: string } = {},
	) {
		const result = await handleContentCreate(db, "page", {
			data: { title },
			slug: title.toLowerCase(),
			status: "published",
			...options,
		});
		if (!result.success) throw new Error(`Page setup failed: ${result.error.message}`);
		return result.data.item;
	}

	it("stores the homepage a settings request names", async () => {
		const page = await createPage("Welcome");

		const saved = await post({ homepage: { collection: "page", id: page.id } });

		const homepage = { collection: "page", id: page.id, entry: live(page.id) };
		expect(saved.status).toBe(200);
		expect(saved.body.data.homepage).toEqual(homepage);
		expect((await get()).data.homepage).toEqual(homepage);
	});

	it("stores a translation's homepage as the entry it translates", async () => {
		const page = await createPage("Welcome");
		const translation = await createPage("Bienvenidos", { locale: "es", translationOf: page.id });

		const saved = await post({ homepage: { collection: "page", id: translation.id } });

		expect(saved.status).toBe(200);
		expect(saved.body.data.homepage).toEqual({
			collection: "page",
			id: page.translationGroup,
			entry: live(page.id),
		});
	});

	it("clears the homepage when the request sends null", async () => {
		const page = await createPage("Welcome");
		const saved = await post({ homepage: { collection: "page", id: page.id } });
		expect(saved.body.data.homepage).toMatchObject({ collection: "page", id: page.id });

		const cleared = await post({ homepage: null });

		expect(cleared.status).toBe(200);
		expect(cleared.body.data.homepage).toBeUndefined();
	});

	it("refuses a homepage that names no entry, and keeps the stored one", async () => {
		const page = await createPage("Welcome");
		await post({ homepage: { collection: "page", id: page.id } });

		for (const homepage of [
			{ collection: "page", id: "01MISSINGENTRY" },
			{ collection: "missing", id: page.id },
		]) {
			const refused = await post({ homepage });
			expect(refused.status).toBe(400);
			expect(refused.body.error.code).toBe("VALIDATION_ERROR");
		}
		expect((await get()).data.homepage).toEqual({
			collection: "page",
			id: page.id,
			entry: live(page.id),
		});
	});

	it("saves other settings alongside a homepage whose entry was deleted since", async () => {
		const page = await createPage("Welcome");
		await post({ homepage: { collection: "page", id: page.id } });
		await handleContentDelete(db, "page", page.id);
		const settings = (await get()).data;

		const saved = await post({ ...settings, title: "Renamed" });

		expect(saved.status).toBe(200);
		expect(saved.body.data.title).toBe("Renamed");
		expect(saved.body.data.homepage).toEqual({ collection: "page", id: page.id, entry: null });
	});

	it("reports the surviving translation once the original is deleted", async () => {
		const page = await createPage("Welcome");
		const translation = await createPage("Bienvenidos", { locale: "es", translationOf: page.id });
		await post({ homepage: { collection: "page", id: page.id } });
		await handleContentDelete(db, "page", page.id);

		const { homepage } = (await get()).data;

		expect(homepage).toEqual({
			collection: "page",
			id: page.translationGroup,
			entry: { id: translation.id, locale: "es", status: "published" },
		});
	});

	it("prefers a published translation, and reports a draft homepage as a draft", async () => {
		const page = await createPage("Welcome", { status: "draft" });
		await post({ homepage: { collection: "page", id: page.id } });

		expect((await get()).data.homepage.entry).toMatchObject({ id: page.id, status: "draft" });

		const translation = await createPage("Bienvenidos", { locale: "es", translationOf: page.id });

		expect((await get()).data.homepage.entry).toMatchObject({
			id: translation.id,
			status: "published",
		});
	});

	it("reports the translation "/" renders: the default locale's, not the original", async () => {
		// Default "es", original in "en": neither the original nor alphabetical
		// order picks the row "/" renders; only the locale chain does.
		setI18nConfig({ defaultLocale: "es", locales: ["es", "en"] });
		const original = await createPage("Welcome", { locale: "en" });
		const spanish = await createPage("Bienvenidos", { locale: "es", translationOf: original.id });
		await post({ homepage: { collection: "page", id: original.id } });

		expect((await get()).data.homepage.entry).toEqual({ id: spanish.id, locale: "es", status: "published" });
	});

	it("never stores the reported entry", async () => {
		const page = await createPage("Welcome");
		const other = await createPage("Other");
		await post({ homepage: { collection: "page", id: page.id } });

		await post({ homepage: { collection: "page", id: page.id, entry: live(other.id) } });

		const stored = await db
			.selectFrom("options")
			.select("value")
			.where("name", "=", "site:homepage")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(stored.value)).toEqual({ collection: "page", id: page.id });
	});
});
