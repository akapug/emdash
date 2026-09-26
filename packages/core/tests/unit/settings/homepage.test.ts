/**
 * `getHomepage()` resolves the entry a site chose for its root URL.
 *
 * A template renders its default homepage whenever this returns no entry, so
 * every way the chosen entry can stop being servable has to come back as
 * `entry: null` rather than an error page at "/".
 */

import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleContentCreate, handleContentDelete } from "../../../src/api/handlers/content.js";
import { handleSettingsUpdate } from "../../../src/api/handlers/settings.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { emdashLoader } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { getHomepage } from "../../../src/settings/homepage.js";
import { invalidateSiteSettingsCache, setSiteSettings } from "../../../src/settings/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveEntry } from "astro:content";

class QueryCounter implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count++;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

describe("getHomepage", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		invalidateSiteSettingsCache();
		const loader = emdashLoader();
		vi.mocked(getLiveEntry).mockImplementation(async (_collection, filter) => {
			const loaded = await loader.loadEntry({ filter } as never);
			if (loaded && "error" in loaded) return { error: loaded.error } as never;
			return { entry: loaded, cacheHint: loaded?.cacheHint } as never;
		});
	});

	afterEach(async () => {
		setI18nConfig(null);
		invalidateSiteSettingsCache();
		vi.mocked(getLiveEntry).mockReset();
		await teardownTestDatabase(db);
	});

	async function createPage(
		title: string,
		options: { status?: string; locale?: string; translationOf?: string } = {},
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

	async function chooseHomepage(id: string) {
		const result = await handleSettingsUpdate(db, null, { homepage: { collection: "page", id } });
		if (!result.success) throw new Error(`Homepage setup failed: ${result.error.message}`);
	}

	function resolve(context: { editMode?: boolean; locale?: string } = {}) {
		return runWithContext({ editMode: false, db, ...context }, () => getHomepage());
	}

	it("returns no entry and reads only the settings when no homepage is set", async () => {
		await createPage("Welcome");
		const counter = new QueryCounter();

		const result = await runWithContext({ editMode: false, db: db.withPlugin(counter) }, () =>
			getHomepage(),
		);

		expect(result.entry).toBeNull();
		expect(result.collection).toBeNull();
		expect(counter.count).toBe(1);
		expect(getLiveEntry).not.toHaveBeenCalled();
	});

	it("resolves the published entry chosen as the homepage", async () => {
		const page = await createPage("Welcome");
		await chooseHomepage(page.id);

		const result = await resolve();

		expect(result.collection).toBe("page");
		expect(result.entry?.data.id).toBe(page.id);
		expect(result.entry?.data.title).toBe("Welcome");
		expect(result.cacheHint.tags).toContain(page.id);
	});

	it("returns no entry while the homepage is a draft, and tags the collection", async () => {
		const page = await createPage("Welcome", { status: "draft" });
		await chooseHomepage(page.id);

		const result = await resolve();

		expect(result.entry).toBeNull();
		expect(result.collection).toBe("page");
		expect(result.cacheHint.tags).toEqual(["page"]);
	});

	it("shows a draft homepage in edit mode", async () => {
		const page = await createPage("Welcome", { status: "draft" });
		await chooseHomepage(page.id);

		const result = await resolve({ editMode: true });

		expect(result.entry?.data.id).toBe(page.id);
	});

	it("returns no entry once the homepage entry is deleted", async () => {
		const page = await createPage("Welcome");
		await chooseHomepage(page.id);
		await handleContentDelete(db, "page", page.id);

		const result = await resolve();

		expect(result.entry).toBeNull();
	});

	it("returns no entry when the homepage names a collection that no longer exists", async () => {
		await setSiteSettings({ homepage: { collection: "retired", id: "01HOMEPAGE" } }, db);

		const result = await resolve();

		expect(result.entry).toBeNull();
		expect(result.collection).toBe("retired");
	});

	describe("with translations", () => {
		beforeEach(() => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "es"] });
		});

		it("resolves the translation for the request's locale", async () => {
			const page = await createPage("Welcome");
			const translation = await createPage("Bienvenidos", {
				locale: "es",
				translationOf: page.id,
			});
			await chooseHomepage(page.id);

			const english = await resolve({ locale: "en" });
			const spanish = await resolve({ locale: "es" });

			expect(english.entry?.data.id).toBe(page.id);
			expect(english.fallbackLocale).toBeUndefined();
			expect(spanish.entry?.data.id).toBe(translation.id);
			expect(spanish.fallbackLocale).toBeUndefined();
		});

		it("falls back to the default locale while the translation is a draft", async () => {
			const page = await createPage("Welcome");
			await createPage("Bienvenidos", { locale: "es", translationOf: page.id, status: "draft" });
			await chooseHomepage(page.id);

			const spanish = await resolve({ locale: "es" });

			expect(spanish.entry?.data.id).toBe(page.id);
			expect(spanish.fallbackLocale).toBe("en");
		});
	});
});
