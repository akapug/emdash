/**
 * Self-serve streaming site export (.zip) tests — emb/67.
 *
 * Covers:
 * - Streaming zip generation (fflate Zip, never buffering full archive)
 * - Contents: emdash-backup.json, wordpress.xml (WXR 1.2), settings.json,
 *   redirects.json, uploads/*, export.json, README.md
 * - Scrubbing of credentials, tokens, preview/IP secrets, plugin secrets
 * - Worker-limit overflow -> media-manifest.json with signed time-limited URLs
 *   verified by GET /_emdash/api/settings/backups/media/[...key]
 * - Tenant isolation: tenant A export never includes tenant B data, and a
 *   signed URL minted by tenant A is rejected by tenant B
 * - Admin-only auth on export?format=zip and backwards-compatible JSON default
 */

import { unzipSync } from "fflate";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	signExportMediaUrl,
	streamSiteExportZip,
	verifyExportMediaSignature,
} from "../../../src/api/handlers/site-export.js";
import { GET as exportGet } from "../../../src/astro/routes/api/settings/backups/export.js";
import { GET as exportMediaGet } from "../../../src/astro/routes/api/settings/backups/media/[...key].js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import type { DownloadResult, Storage } from "../../../src/storage/types.js";
import { setupTestDatabaseWithCollections } from "../../utils/test-db.js";

interface StoredFile {
	key: string;
	body: Uint8Array;
	contentType: string;
	lastModified: Date;
}

function createFakeStorage(): Storage & { files: Map<string, StoredFile> } {
	const files = new Map<string, StoredFile>();
	return {
		files,
		async upload(options) {
			if (!(options.body instanceof Uint8Array)) {
				throw new Error("fake storage only supports Uint8Array bodies");
			}
			files.set(options.key, {
				key: options.key,
				body: options.body,
				contentType: options.contentType,
				lastModified: new Date(),
			});
			return { key: options.key, url: `fake://${options.key}`, size: options.body.byteLength };
		},
		async download(key): Promise<DownloadResult> {
			const file = files.get(key);
			if (!file) throw new Error(`not found: ${key}`);
			return {
				body: new Blob([file.body]).stream(),
				contentType: file.contentType,
				size: file.body.byteLength,
			};
		},
		async delete(key) {
			files.delete(key);
		},
		async exists(key) {
			return files.has(key);
		},
		async list(options) {
			const prefix = options?.prefix ?? "";
			return {
				files: [...files.values()]
					.filter((f) => f.key.startsWith(prefix))
					.map((f) => ({
						key: f.key,
						size: f.body.byteLength,
						lastModified: f.lastModified,
					})),
			};
		},
		async getSignedUploadUrl() {
			throw new Error("not used");
		},
		getPublicUrl(key) {
			return `/_emdash/api/media/file/${key}`;
		},
	};
}

async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

const dec = (bytes: Uint8Array | undefined): string =>
	bytes ? new TextDecoder().decode(bytes) : "";

async function seedTenant(
	db: Kysely<Database>,
	storage: Storage,
	tag: string,
): Promise<{ mediaKeys: string[] }> {
	const opts = new OptionsRepository(db);
	await opts.set("emdash:site_title", `${tag} Site`);
	await opts.set("emdash:site_tagline", `${tag} Tagline`);
	await opts.set("emdash:locale", "en");
	await opts.set("site:theme_accent", `#${tag.slice(0, 6)}`);
	// Secrets that must NEVER appear in the export
	await opts.set("emdash:preview_secret", `preview-secret-${tag}`);
	await opts.set("emdash:ip_salt", `ip-salt-${tag}`);
	await opts.set("emdash:passkey_pending:req1", `pending-passkey-${tag}`);
	await opts.set("plugin:embark-helper:linkKey", `helper-link-${tag}`);
	await opts.set("plugin:stripe:apiKey", `sk_live_${tag}`);

	const now = new Date().toISOString();
	await sql`
		INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, published_at, version)
		VALUES (
			${`post-${tag}`},
			${`hello-${tag}`},
			'published',
			${`Hello ${tag}`},
			${JSON.stringify([
				{
					_type: "block",
					style: "normal",
					children: [{ _type: "span", text: `Body text for ${tag} site.` }],
				},
			])},
			${now},
			${now},
			${now},
			1
		)
	`.execute(db);

	await sql`
		INSERT INTO _emdash_menus (id, name, label, created_at, updated_at)
		VALUES (${`menu-${tag}`}, 'main', 'Main', ${now}, ${now})
	`.execute(db);
	await sql`
		INSERT INTO _emdash_menu_items (id, menu_id, sort_order, type, custom_url, label, created_at)
		VALUES (${`item-${tag}`}, ${`menu-${tag}`}, 0, 'custom', '/', ${`Home ${tag}`}, ${now})
	`.execute(db);

	await sql`
		INSERT INTO _emdash_redirects (id, source, destination, type, is_pattern, enabled, created_at, updated_at)
		VALUES (${`redir-${tag}`}, ${`/old-${tag}`}, ${`/hello-${tag}`}, 301, 0, 1, ${now}, ${now})
	`.execute(db);

	const key1 = `${tag}/hero.png`;
	const key2 = `${tag}/large.bin`;
	const bytes1 = new TextEncoder().encode(`PNG-${tag}`);
	const bytes2 = new Uint8Array(64).fill(tag.charCodeAt(0));
	await storage.upload({ key: key1, body: bytes1, contentType: "image/png" });
	await storage.upload({ key: key2, body: bytes2, contentType: "application/octet-stream" });
	// Stray private backup file in storage — must never be exported
	await storage.upload({
		key: `backups/emdash-backup-2026-07-09T08-45-12-abcd1234.json`,
		body: new TextEncoder().encode(`{"secret":"private-backup-${tag}"}`),
		contentType: "application/json",
	});

	await sql`
		INSERT INTO media (id, filename, storage_key, mime_type, size, status, created_at)
		VALUES
			(${`m1-${tag}`}, 'hero.png', ${key1}, 'image/png', ${bytes1.byteLength}, 'ready', ${now}),
			(${`m2-${tag}`}, 'large.bin', ${key2}, 'application/octet-stream', ${bytes2.byteLength}, 'ready', ${now})
	`.execute(db);

	return { mediaKeys: [key1, key2] };
}

describe("self-serve streaming site export zip (emb/67)", () => {
	let db: Kysely<Database>;
	let storage: ReturnType<typeof createFakeStorage>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		storage = createFakeStorage();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("streams a complete zip with WXR, EmDash JSON, settings/menus, redirects, media, and README while scrubbing all secrets", async () => {
		await seedTenant(db, storage, "alpha");

		const stream = await streamSiteExportZip({
			db,
			storage,
			siteUrl: "https://alpha.example.org",
			now: new Date("2026-10-01T12:00:00Z"),
		});
		const zipBytes = await readStreamToBytes(stream);
		const files = unzipSync(zipBytes);

		expect(Object.keys(files).sort()).toEqual([
			"README.md",
			"emdash-backup.json",
			"export.json",
			"redirects.json",
			"settings.json",
			"uploads/alpha/hero.png",
			"uploads/alpha/large.bin",
			"wordpress.xml",
		]);

		// Content in both EmDash JSON and WXR 1.2
		const backup = JSON.parse(dec(files["emdash-backup.json"]));
		expect(backup.format).toBe("emdash-backup");
		expect(backup.tables.ec_post).toHaveLength(1);
		expect(backup.tables._emdash_redirects).toHaveLength(1);

		const wxr = dec(files["wordpress.xml"]);
		expect(wxr).toContain('xmlns:wp="http://wordpress.org/export/1.2/"');
		expect(wxr).toContain("Hello alpha");
		expect(wxr).toContain("Body text for alpha site.");

		// Settings + menus + theme tokens
		const settings = JSON.parse(dec(files["settings.json"]));
		expect(settings.options["emdash:site_title"]).toBe("alpha Site");
		expect(settings.options["site:theme_accent"]).toBe("#alpha");
		expect(settings.menus).toHaveLength(1);
		expect(settings.menuItems).toHaveLength(1);

		// Redirects
		const redirects = JSON.parse(dec(files["redirects.json"]));
		expect(redirects).toHaveLength(1);
		expect(redirects[0]).toMatchObject({ source: "/old-alpha", destination: "/hello-alpha", type: 301 });

		// Media bytes match
		expect(dec(files["uploads/alpha/hero.png"])).toBe("PNG-alpha");
		expect(files["uploads/alpha/large.bin"]?.byteLength).toBe(64);

		// README covers public EmDash on Node and WXR import
		const readme = dec(files["README.md"]);
		expect(readme).toContain("alpha.example.org");
		expect(readme).toContain("wordpress.xml");
		expect(readme).toContain("emdash-backup.json");

		// Zero secrets or private backup files leaked anywhere in the archive
		const allText = Object.values(files)
			.map((b) => dec(b))
			.join("\n");
		for (const secret of [
			"preview-secret-alpha",
			"ip-salt-alpha",
			"pending-passkey-alpha",
			"helper-link-alpha",
			"sk_live_alpha",
			"private-backup-alpha",
		]) {
			expect(allText).not.toContain(secret);
		}
	});

	it("spills media past the Worker byte limit into media-manifest.json with signed time-limited URLs that serve the bytes", async () => {
		await seedTenant(db, storage, "alpha");

		const stream = await streamSiteExportZip({
			db,
			storage,
			siteUrl: "https://alpha.example.org",
			maxInlineMediaBytes: 20, // hero.png (9B) fits; large.bin (64B) overflows
		});
		const files = unzipSync(await readStreamToBytes(stream));

		expect(files["uploads/alpha/hero.png"]).toBeDefined();
		expect(files["uploads/alpha/large.bin"]).toBeUndefined();
		expect(files["media-manifest.json"]).toBeDefined();

		const manifest = JSON.parse(dec(files["media-manifest.json"])) as {
			expiresAt: string;
			items: Array<{ storageKey: string; url: string; size: number; mimeType: string }>;
		};
		expect(manifest.items).toHaveLength(1);
		expect(manifest.items[0]?.storageKey).toBe("alpha/large.bin");
		expect(manifest.items[0]?.url).toContain("/_emdash/api/settings/backups/media/alpha/large.bin?exp=");

		const readme = dec(files["README.md"]);
		expect(readme).toContain("media-manifest.json");

		// Signed URL works on GET /_emdash/api/settings/backups/media/[...key]
		const signedUrl = new URL(manifest.items[0]!.url);
		const okRes = await exportMediaGet({
			params: { key: "alpha/large.bin" },
			request: new Request(signedUrl.toString()),
			locals: { emdash: { db, storage }, user: null },
		} as never);
		expect(okRes.status).toBe(200);
		expect(new Uint8Array(await okRes.arrayBuffer()).byteLength).toBe(64);

		// Tampered signature is refused
		signedUrl.searchParams.set("sig", "0".repeat(64));
		const badSig = await exportMediaGet({
			params: { key: "alpha/large.bin" },
			request: new Request(signedUrl.toString()),
			locals: { emdash: { db, storage }, user: null },
		} as never);
		expect(badSig.status).toBe(403);

		// Expired signature is refused
		const expiredUrl = await signExportMediaUrl({
			origin: "https://alpha.example.org",
			key: "alpha/large.bin",
			secret: "preview-secret-alpha",
			expiresAtSec: Math.floor(Date.now() / 1000) - 60,
		});
		const expiredRes = await exportMediaGet({
			params: { key: "alpha/large.bin" },
			request: new Request(expiredUrl),
			locals: { emdash: { db, storage }, user: null },
		} as never);
		expect(expiredRes.status).toBe(403);

		// Private storage prefix is refused even with a valid signature
		const privateUrl = await signExportMediaUrl({
			origin: "https://alpha.example.org",
			key: "backups/emdash-backup-2026-07-09T08-45-12-abcd1234.json",
			secret: "preview-secret-alpha",
			expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
		});
		const privateRes = await exportMediaGet({
			params: { key: "backups/emdash-backup-2026-07-09T08-45-12-abcd1234.json" },
			request: new Request(privateUrl),
			locals: { emdash: { db, storage }, user: null },
		} as never);
		expect(privateRes.status).toBe(404);
	});

	it("tenant isolation: tenant A export never leaks tenant B data and tenant A signed URL is refused by tenant B", async () => {
		const dbB = await setupTestDatabaseWithCollections();
		const storageB = createFakeStorage();
		try {
			await seedTenant(db, storage, "alpha");
			await seedTenant(dbB, storageB, "bravo");

			const streamA = await streamSiteExportZip({
				db,
				storage,
				siteUrl: "https://alpha.example.org",
				maxInlineMediaBytes: 20,
			});
			const filesA = unzipSync(await readStreamToBytes(streamA));
			const allA = Object.values(filesA)
				.map((b) => dec(b))
				.join("\n");
			expect(allA).not.toContain("bravo");
			expect(Object.keys(filesA).some((k) => k.includes("bravo"))).toBe(false);

			// Signed URL minted by tenant A must be rejected by tenant B
			const manifestA = JSON.parse(dec(filesA["media-manifest.json"])) as {
				items: Array<{ storageKey: string; url: string }>;
			};
			const urlFromA = manifestA.items[0]!.url;
			const crossTenantRes = await exportMediaGet({
				params: { key: "alpha/large.bin" },
				request: new Request(urlFromA),
				locals: { emdash: { db: dbB, storage: storageB }, user: null },
			} as never);
			expect(crossTenantRes.status).toBe(403);

			// Direct verifier rejects wrong secret
			const parsed = new URL(urlFromA);
			const validOnB = await verifyExportMediaSignature({
				key: "alpha/large.bin",
				exp: parsed.searchParams.get("exp") ?? "",
				sig: parsed.searchParams.get("sig") ?? "",
				secret: "preview-secret-bravo",
			});
			expect(validOnB).toBe(false);
		} finally {
			await dbB.destroy();
		}
	});

	it("route GET /_emdash/api/settings/backups/export?format=zip enforces admin auth and preserves default JSON format", async () => {
		await seedTenant(db, storage, "alpha");

		const anon = await exportGet({
			request: new Request("https://alpha.example.org/_emdash/api/settings/backups/export?format=zip"),
			locals: { emdash: { db, storage }, user: null },
		} as never);
		expect(anon.status).toBe(401);

		const editor = await exportGet({
			request: new Request("https://alpha.example.org/_emdash/api/settings/backups/export?format=zip"),
			locals: { emdash: { db, storage }, user: { id: "u1", role: 40 } },
		} as never);
		expect(editor.status).toBe(403);

		const zipRes = await exportGet({
			request: new Request("https://alpha.example.org/_emdash/api/settings/backups/export?format=zip"),
			locals: { emdash: { db, storage }, user: { id: "u1", role: 50 } },
		} as never);
		expect(zipRes.status).toBe(200);
		expect(zipRes.headers.get("Content-Type")).toBe("application/zip");
		expect(zipRes.headers.get("Cache-Control")).toBe("private, no-store");
		const unzipped = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
		expect(unzipped["wordpress.xml"]).toBeDefined();

		const jsonRes = await exportGet({
			request: new Request("https://alpha.example.org/_emdash/api/settings/backups/export"),
			locals: { emdash: { db, storage }, user: { id: "u1", role: 50 } },
		} as never);
		expect(jsonRes.status).toBe(200);
		expect(jsonRes.headers.get("Content-Type")).toBe("application/json");
	});
});
