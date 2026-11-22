/**
 * Self-serve streaming site export (.zip) — emb/67.
 *
 * Streams a portable ZIP archive directly from the site's own database and
 * storage using `fflate`'s streaming `Zip` driven by `ReadableStream` `pull()`
 * backpressure. Text metadata members (`emdash-backup.json`, `wordpress.xml`,
 * `settings.json`, `redirects.json`) are assembled first; media binaries and
 * the ZIP output chunks are streamed incrementally so large media buckets are
 * never buffered whole in memory:
 *
 *   emdash-backup.json  EmDash portable JSON backup (content, schema, menus,
 *                       widgets, taxonomies, redirects, media metadata, safe
 *                       settings, and private bodies of password-protected pages
 *                       with password verifiers scrubbed)
 *   wordpress.xml       WordPress WXR 1.2 export (text/image blocks; protected
 *                       pages hydrated and written as drafts)
 *   settings.json       Safe site settings (title, tagline, locale, theme tokens) + menus
 *   redirects.json      All `_emdash_redirects` rules
 *   uploads/<key>       Media binaries streamed chunk-by-chunk from storage
 *   media-manifest.json Present when media exceeds the Worker inline budget;
 *                       holds signed, time-limited download URLs for overflow files
 *   export.json         Machine-readable summary of exported counts, missing
 *                       media, protected entries, and scrubbed data
 *   README.md           How to run the site on public EmDash (Node) or import WXR anywhere
 *
 * Credentials, sessions, API/OAuth tokens, passkey challenges, password
 * verifiers, preview/IP secrets, and plugin secrets are never included.
 */

import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { sql } from "kysely";
import type { Kysely } from "kysely";

import { resolveSecrets } from "../../config/secrets.js";
import type { Database } from "../../database/types.js";
import type { Storage } from "../../storage/types.js";
import { isRefusedStorageKey } from "../../transfer/staging/keys.js";
import { VERSION } from "../../version.js";
import { generateSnapshot, type Snapshot } from "./snapshot.js";

/** Default inline media cap per single Worker export request (32 MiB). */
export const DEFAULT_MAX_INLINE_MEDIA_BYTES = 32 * 1024 * 1024;
/** Default inline media file cap per single Worker export request. */
export const DEFAULT_MAX_INLINE_MEDIA_FILES = 200;
/** Default TTL for signed overflow media download URLs (24 hours). */
export const DEFAULT_SIGNED_MEDIA_TTL_SECONDS = 24 * 60 * 60;

/**
 * Safe option prefixes included in exports (theme tokens, site customizer).
 * Never widen to `plugin:` or `emdash:` secrets.
 */
const EXPORT_OPTION_PREFIXES = ["site:"];

/** Exact `emdash:*` options safe to include in user-downloadable exports. */
const EXPORT_OPTION_KEYS = [
	"emdash:site_title",
	"emdash:site_tagline",
	"emdash:locale",
	"emdash:homepage",
];

/** Domain separation prefix for signed export media URLs. */
const EXPORT_MEDIA_SIG_DOMAIN = "export-media:";

/** Exported route path for signed overflow media downloads. */
export const EXPORT_MEDIA_ROUTE_PREFIX = "/_emdash/api/settings/backups/media/";

const MAX_KEY_DECODES = 3;

/**
 * Validate a storage key before placing it under `uploads/` or serving it via
 * a signed export URL. Refuses path traversal, private prefixes (`backups/`,
 * `transfers/`), NUL/backslashes, and multi-layer percent-encoded bypasses.
 */
export function isSafeExportMediaKey(key: string): boolean {
	if (typeof key !== "string" || key.length === 0) return false;
	if (key.includes("\0") || key.includes("\\") || key.startsWith("/")) return false;
	const segments = key.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
	if (segments.some((s) => new TextEncoder().encode(s).byteLength > 255)) return false;

	let candidate = key;
	for (let layer = 0; layer <= MAX_KEY_DECODES; layer++) {
		if (isRefusedStorageKey(candidate)) return false;
		let decoded: string;
		try {
			decoded = decodeURIComponent(candidate);
		} catch {
			return false;
		}
		if (decoded === candidate) return true;
		candidate = decoded;
	}
	return false;
}

/** Derive a zip filename for a given timestamp. */
export function exportZipFilename(date: Date): string {
	const stamp = date.toISOString().slice(0, 19).replaceAll(":", "-");
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
	return `emdash-export-${stamp}-${suffix}.zip`;
}

// ── Signed time-limited media URLs ──────────────────────────────

async function hmacHex(secret: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a signed, time-limited download URL for a single media storage key. */
export async function signExportMediaUrl(opts: {
	origin: string;
	key: string;
	secret: string;
	expiresAtSec: number;
}): Promise<string> {
	const exp = String(Math.trunc(opts.expiresAtSec));
	const sig = await hmacHex(opts.secret, `${EXPORT_MEDIA_SIG_DOMAIN}${opts.key}:${exp}`);
	const encodedKey = opts.key
		.split("/")
		.map((seg) => encodeURIComponent(seg))
		.join("/");
	const base = opts.origin.replace(/\/+$/, "");
	return `${base}${EXPORT_MEDIA_ROUTE_PREFIX}${encodedKey}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
}

/** Constant-time verification of a signed export media URL. */
export async function verifyExportMediaSignature(opts: {
	key: string;
	exp: string;
	sig: string;
	secret: string;
	nowSec?: number;
}): Promise<boolean> {
	if (!/^\d+$/.test(opts.exp) || !/^[0-9a-f]{64}$/i.test(opts.sig)) return false;
	const expNum = Number.parseInt(opts.exp, 10);
	const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
	if (!Number.isFinite(expNum) || expNum < nowSec) return false;

	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(opts.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const sigBytes = new Uint8Array(opts.sig.length / 2);
	for (let i = 0; i < opts.sig.length; i += 2) {
		sigBytes[i / 2] = Number.parseInt(opts.sig.slice(i, i + 2), 16);
	}
	return crypto.subtle.verify(
		"HMAC",
		cryptoKey,
		sigBytes,
		encoder.encode(`${EXPORT_MEDIA_SIG_DOMAIN}${opts.key}:${opts.exp}`),
	);
}

// ── WXR 1.2 generation ──────────────────────────────────────────

const xmlEscape = (text: string): string =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

const cdata = (text: string): string => `<![CDATA[${text.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

function safeHref(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const href = raw.trim();
	if (!href) return null;
	if (href.startsWith("/") || href.startsWith("#")) return href;
	try {
		const u = new URL(href);
		if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") return href;
	} catch {
		return null;
	}
	return null;
}

function renderPortableText(blocks: unknown, siteUrl: string): string {
	if (typeof blocks === "string") return blocks;
	if (!Array.isArray(blocks)) return "";
	const out: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b._type === "block") {
			const markDefs = new Map<string, Record<string, unknown>>();
			if (Array.isArray(b.markDefs)) {
				for (const def of b.markDefs) {
					if (def && typeof def === "object" && typeof (def as Record<string, unknown>)._key === "string") {
						markDefs.set((def as Record<string, unknown>)._key as string, def as Record<string, unknown>);
					}
				}
			}
			const children = Array.isArray(b.children) ? b.children : [];
			const inner = children
				.map((child) => {
					if (!child || typeof child !== "object") return "";
					const c = child as Record<string, unknown>;
					let text = xmlEscape(typeof c.text === "string" ? c.text : "");
					const marks = Array.isArray(c.marks) ? c.marks : [];
					for (const mark of marks) {
						if (mark === "strong") text = `<strong>${text}</strong>`;
						else if (mark === "em") text = `<em>${text}</em>`;
						else if (mark === "code") text = `<code>${text}</code>`;
						else if (typeof mark === "string" && markDefs.has(mark)) {
							const def = markDefs.get(mark)!;
							const href = safeHref(def.href);
							if (href) text = `<a href="${xmlEscape(href)}">${text}</a>`;
						}
					}
					return text;
				})
				.join("");
			const style = typeof b.style === "string" ? b.style : "normal";
			if (/^h[1-6]$/.test(style)) out.push(`<${style}>${inner}</${style}>`);
			else if (style === "blockquote") out.push(`<blockquote><p>${inner}</p></blockquote>`);
			else out.push(`<p>${inner}</p>`);
		} else if (b._type === "image") {
			const rawSrc = typeof b.src === "string" ? b.src : typeof b.url === "string" ? b.url : "";
			const src = rawSrc.startsWith("/") ? `${siteUrl}${rawSrc}` : rawSrc;
			const alt = typeof b.alt === "string" ? b.alt : "";
			if (src) out.push(`<figure><img src="${xmlEscape(src)}" alt="${xmlEscape(alt)}" /></figure>`);
		}
	}
	return out.join("\n");
}

function wpDate(raw: unknown, fallback: Date): string {
	const d = typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : fallback;
	return d.toISOString().replace("T", " ").slice(0, 19);
}

function mapWpStatus(status: unknown): string {
	switch (status) {
		case "published":
			return "publish";
		case "scheduled":
			return "future";
		case "trashed":
			return "trash";
		default:
			return "draft";
	}
}

interface ProtectedContentExportRow {
	collection: string;
	contentId: string;
	data: Record<string, unknown>;
	seo: Record<string, unknown> | null;
}

interface ProtectedRevisionExportRow {
	collection: string;
	contentId: string;
	revisionId: string;
	data: Record<string, unknown>;
}

interface ProtectedEntrySummary {
	collection: string;
	contentId: string;
	slug: string;
}

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw !== "string" || raw.trim() === "") return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

async function readProtectedContent(db: Kysely<Database>): Promise<ProtectedContentExportRow[]> {
	try {
		// Deliberately select ONLY private body + seo; NEVER select `verifier` or `credential_version`.
		const res = await sql<{
			collection: string;
			content_id: string;
			data: string;
			seo: string | null;
		}>`
			SELECT collection, content_id, data, seo
			FROM _emdash_protected_content
			ORDER BY collection, content_id
		`.execute(db);
		return res.rows.map((row) => ({
			collection: row.collection,
			contentId: row.content_id,
			data: parseJsonRecord(row.data) ?? {},
			seo: parseJsonRecord(row.seo),
		}));
	} catch {
		return [];
	}
}

async function readProtectedRevisions(db: Kysely<Database>): Promise<ProtectedRevisionExportRow[]> {
	try {
		const res = await sql<{
			collection: string;
			content_id: string;
			revision_id: string;
			data: string;
		}>`
			SELECT collection, content_id, revision_id, data
			FROM _emdash_protected_revisions
			ORDER BY collection, content_id, revision_id
		`.execute(db);
		return res.rows.map((row) => ({
			collection: row.collection,
			contentId: row.content_id,
			revisionId: row.revision_id,
			data: parseJsonRecord(row.data) ?? {},
		}));
	} catch {
		return [];
	}
}

function buildWxrFromSnapshot(opts: {
	snapshot: Snapshot;
	protectedByKey: ReadonlyMap<string, Record<string, unknown>>;
	siteTitle: string;
	siteTagline: string;
	siteUrl: string;
	now: Date;
}): { xml: string; itemCount: number; protectedEntries: ProtectedEntrySummary[] } {
	const base = opts.siteUrl.replace(/\/+$/, "");
	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8" ?>',
		'<rss version="2.0"',
		'  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"',
		'  xmlns:content="http://purl.org/rss/1.0/modules/content/"',
		'  xmlns:wfw="http://wellformedweb.org/CommentAPI/"',
		'  xmlns:dc="http://purl.org/dc/elements/1.1/"',
		'  xmlns:wp="http://wordpress.org/export/1.2/"',
		">",
		"<channel>",
		`  <title>${xmlEscape(opts.siteTitle)}</title>`,
		`  <link>${xmlEscape(base)}</link>`,
		`  <description>${xmlEscape(opts.siteTagline)}</description>`,
		`  <pubDate>${opts.now.toUTCString()}</pubDate>`,
		"  <wp:wxr_version>1.2</wp:wxr_version>",
		`  <wp:base_site_url>${xmlEscape(base)}</wp:base_site_url>`,
		`  <wp:base_blog_url>${xmlEscape(base)}</wp:base_blog_url>`,
		`  <generator>EmDash ${xmlEscape(VERSION)}</generator>`,
	];

	let nextWpId = 1;
	let itemCount = 0;
	const protectedEntries: ProtectedEntrySummary[] = [];

	for (const [tableName, rows] of Object.entries(opts.snapshot.tables)) {
		if (!tableName.startsWith("ec_")) continue;
		const collection = tableName.slice(3);
		const postType = collection === "posts" || collection === "post" ? "post" : collection === "pages" || collection === "page" ? "page" : collection;
		for (const row of rows) {
			const entryId = typeof row.id === "string" ? row.id : "";
			const protectedData = entryId ? opts.protectedByKey.get(`${collection}:${entryId}`) : undefined;
			const data = protectedData ?? parseJsonRecord(row.data) ?? {};
			const slug = typeof row.slug === "string" ? row.slug : "";
			const title =
				typeof data.title === "string" && data.title.length > 0
					? data.title
					: typeof row.title === "string" && row.title.length > 0
						? row.title
						: slug || "Untitled";
			const excerpt =
				typeof data.excerpt === "string"
					? data.excerpt
					: typeof row.excerpt === "string"
						? row.excerpt
						: "";
			let rawContent: unknown = protectedData
				? (data.content ?? data.body ?? "")
				: (row.content ?? row.body ?? data.content ?? data.body ?? "");
			if (typeof rawContent === "string" && rawContent.trimStart().startsWith("[")) {
				try {
					rawContent = JSON.parse(rawContent);
				} catch {
					// Keep as string if not valid JSON
				}
			}
			const html = renderPortableText(rawContent, base);
			const created = wpDate(row.published_at ?? row.created_at, opts.now);
			// Protected pages are always written as draft in WXR because passwords are not exported.
			const status = row.deleted_at ? "trash" : protectedData ? "draft" : mapWpStatus(row.status);
			if (protectedData) {
				protectedEntries.push({ collection, contentId: entryId, slug });
			}
			const wpId = nextWpId++;
			itemCount++;
			const link = slug ? `${base}/${postType === "page" ? slug : `${collection}/${slug}`}` : base;

			lines.push(
				"  <item>",
				`    <title>${xmlEscape(title)}</title>`,
				`    <link>${xmlEscape(link)}</link>`,
				`    <wp:post_id>${wpId}</wp:post_id>`,
				`    <wp:post_date>${created}</wp:post_date>`,
				`    <wp:post_date_gmt>${created}</wp:post_date_gmt>`,
				`    <wp:post_name>${cdata(slug)}</wp:post_name>`,
				`    <wp:status>${cdata(status)}</wp:status>`,
				`    <wp:post_type>${cdata(postType)}</wp:post_type>`,
				`    <content:encoded>${cdata(html)}</content:encoded>`,
				`    <excerpt:encoded>${cdata(excerpt)}</excerpt:encoded>`,
				"  </item>",
			);
		}
	}

	const mediaRows = opts.snapshot.tables.media ?? [];
	for (const media of mediaRows) {
		const storageKey = typeof media.storage_key === "string" ? media.storage_key : "";
		if (!isSafeExportMediaKey(storageKey)) continue;
		const filename = typeof media.filename === "string" ? media.filename : storageKey;
		const attachmentUrl = `${base}/_emdash/api/media/file/${storageKey
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/")}`;
		const created = wpDate(media.created_at, opts.now);
		const wpId = nextWpId++;
		lines.push(
			"  <item>",
			`    <title>${xmlEscape(filename)}</title>`,
			`    <wp:post_id>${wpId}</wp:post_id>`,
			`    <wp:post_date>${created}</wp:post_date>`,
			`    <wp:post_date_gmt>${created}</wp:post_date_gmt>`,
			`    <wp:status>${cdata("inherit")}</wp:status>`,
			`    <wp:post_type>${cdata("attachment")}</wp:post_type>`,
			`    <wp:attachment_url>${cdata(attachmentUrl)}</wp:attachment_url>`,
			"  </item>",
		);
	}

	lines.push("</channel>", "</rss>", "");
	return { xml: lines.join("\n"), itemCount, protectedEntries };
}

// ── README ──────────────────────────────────────────────────────

function buildExportReadme(opts: {
	siteUrl: string;
	exportedAt: Date;
	contentCount: number;
	redirectCount: number;
	inlineMediaCount: number;
	overflowMediaCount: number;
	missingMediaCount: number;
	storageConfigured: boolean;
	manifestExpiresAt: string | null;
	protectedEntries: readonly ProtectedEntrySummary[];
}): string {
	let host = opts.siteUrl;
	try {
		host = new URL(opts.siteUrl).host;
	} catch {
		host = opts.siteUrl;
	}
	const lines = [
		`# Your site export, ${host}`,
		"",
		`This archive is a self-serve export of ${opts.siteUrl}, generated on ${opts.exportedAt.toISOString().slice(0, 10)}. It contains your content, settings, menus, redirects, and media so you can run your site on your own server or move it to another CMS.`,
		"",
		"## What is in this archive",
		"",
		"- `emdash-backup.json`: portable EmDash JSON export (all collections, drafts, trash, pending draft revisions, rich/custom blocks, schemas, taxonomies, menus, widgets, redirects, media metadata, safe site settings, and full private bodies of password-protected pages under `protectedContent` without password verifiers).",
		`- \`wordpress.xml\`: your content (${opts.contentCount} item(s)) as a WordPress WXR 1.2 file for importing into WordPress or any CMS that reads WXR. Note: \`wordpress.xml\` carries text and image blocks only; pending draft revisions and non-text/image blocks (embeds, galleries, forms) are preserved in \`emdash-backup.json\`.`,
		`- \`settings.json\`: site title, tagline, locale, theme tokens (\`site:*\`), and navigation menus.`,
		`- \`redirects.json\`: ${opts.redirectCount} redirect rule(s).`,
		`- \`uploads/\`: ${opts.inlineMediaCount} media file(s) included directly in this archive.`,
		...(opts.overflowMediaCount > 0
			? [
					`- \`media-manifest.json\`: ${opts.overflowMediaCount} additional media file(s) that exceeded the single-request archive size limit. Each entry includes a signed, time-limited download URL (valid until ${opts.manifestExpiresAt ?? "expiration"}). Download those files into \`uploads/<storageKey>\` before the links expire.`,
				]
			: []),
		...(!opts.storageConfigured
			? [
					"- Note: no media storage backend was configured when this export ran, so media binaries could not be included; `export.json` lists the media keys.",
				]
			: opts.missingMediaCount > 0
				? [
						`- Note: ${opts.missingMediaCount} media file(s) could not be read from storage; \`export.json\` lists their keys under \`media.missing\`.`,
					]
				: []),
		...(opts.protectedEntries.length > 0
			? [
					`- Password-protected pages (${opts.protectedEntries.map((p) => `${p.collection}/${p.slug || p.contentId}`).join(", ")}): their full private bodies are included in \`emdash-backup.json\` (\`protectedContent\`) and as \`draft\` in \`wordpress.xml\` because password verifiers are never exported. Set a new password before publishing them elsewhere.`,
				]
			: []),
		"- `export.json`: machine-readable summary of exported counts, protected entries, missing media, and scrubbed fields.",
		"",
		"## Run it on public EmDash (Node / VPS)",
		"",
		`1. Create an EmDash Node project (EmDash ${VERSION} or newer) following EmDash's public Node deployment docs.`,
		"2. Copy the `uploads/` directory (plus any files downloaded from `media-manifest.json`) to persistent, writable local media storage.",
		"3. Import `emdash-backup.json` (or `wordpress.xml`) and apply `redirects.json` and `settings.json`.",
		"4. Set `EMDASH_SITE_URL` to your domain, run database migrations, and start the Node server behind HTTPS.",
		"",
		"## Import into WordPress or another CMS",
		"",
		"In WordPress: go to Tools -> Import -> WordPress and upload `wordpress.xml`. All media files are also included under `uploads/` (and `media-manifest.json` if split).",
		"",
		"## What was scrubbed",
		"",
		"- User accounts, sessions, passkey challenges, API tokens, OAuth tokens, and device/authorization codes.",
		"- Password verifiers for password-protected pages (`_emdash_protected_content.verifier`).",
		"- Site signing secrets (`emdash:preview_secret`, `emdash:ip_salt`, pending passkey registrations) and plugin secrets (`plugin:*`).",
		"- Internal site-transfer staging tables and private backup archives.",
		"",
	];
	return lines.join("\n");
}

// ── Streaming ZIP builder ───────────────────────────────────────

export interface StreamSiteExportOptions {
	db: Kysely<Database>;
	storage?: Storage;
	siteUrl: string;
	now?: Date;
	maxInlineMediaBytes?: number;
	maxInlineMediaFiles?: number;
	signedUrlTtlSeconds?: number;
}

interface RedirectRow {
	id: string;
	source: string;
	destination: string;
	type: number;
	is_pattern: number;
	enabled: number;
	group_name: string | null;
}

async function readRedirects(db: Kysely<Database>): Promise<RedirectRow[]> {
	try {
		const res = await sql<RedirectRow>`
			SELECT id, source, destination, type, is_pattern, enabled, group_name
			FROM _emdash_redirects
			ORDER BY id
		`.execute(db);
		return res.rows;
	} catch {
		return [];
	}
}

function parseOptionValue(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/**
 * Stream a complete, scrubbed self-serve site export as a ZIP `ReadableStream`.
 *
 * Uses `fflate`'s streaming `Zip` driven from `ReadableStream` `pull()`
 * backpressure so media binaries and ZIP chunks are streamed incrementally.
 */
export async function streamSiteExportZip(
	opts: StreamSiteExportOptions,
): Promise<ReadableStream<Uint8Array>> {
	const now = opts.now ?? new Date();
	const maxInlineBytes = opts.maxInlineMediaBytes ?? DEFAULT_MAX_INLINE_MEDIA_BYTES;
	const maxInlineFiles = opts.maxInlineMediaFiles ?? DEFAULT_MAX_INLINE_MEDIA_FILES;
	const ttlSec = opts.signedUrlTtlSeconds ?? DEFAULT_SIGNED_MEDIA_TTL_SECONDS;
	const origin = opts.siteUrl.replace(/\/+$/, "");

	const snapshot = await generateSnapshot(opts.db, {
		includeDrafts: true,
		includeTrashed: true,
		optionPrefixes: EXPORT_OPTION_PREFIXES,
		optionKeys: EXPORT_OPTION_KEYS,
	});
	const redirects = await readRedirects(opts.db);
	if (redirects.length > 0) {
		snapshot.tables._emdash_redirects = redirects as unknown as Record<string, unknown>[];
	}
	const protectedContent = await readProtectedContent(opts.db);
	const protectedRevisions = await readProtectedRevisions(opts.db);
	const protectedByKey = new Map<string, Record<string, unknown>>();
	for (const item of protectedContent) {
		protectedByKey.set(`${item.collection}:${item.contentId}`, item.data);
	}

	const optionsMap: Record<string, unknown> = {};
	for (const row of snapshot.tables.options ?? []) {
		if (typeof row.name === "string") {
			optionsMap[row.name] = parseOptionValue(row.value);
		}
	}
	const siteTitle = typeof optionsMap["emdash:site_title"] === "string" ? optionsMap["emdash:site_title"] : origin;
	const siteTagline = typeof optionsMap["emdash:site_tagline"] === "string" ? optionsMap["emdash:site_tagline"] : "";

	const backupJson = JSON.stringify(
		{
			format: "emdash-backup",
			formatVersion: 1,
			emdashVersion: VERSION,
			generatedAt: snapshot.generatedAt,
			schema: snapshot.schema,
			tables: snapshot.tables,
			...(protectedContent.length > 0 ? { protectedContent } : {}),
			...(protectedRevisions.length > 0 ? { protectedRevisions } : {}),
		},
		null,
		2,
	);
	const settingsJson = JSON.stringify(
		{
			siteUrl: origin,
			options: optionsMap,
			menus: snapshot.tables._emdash_menus ?? [],
			menuItems: snapshot.tables._emdash_menu_items ?? [],
		},
		null,
		2,
	);
	const redirectsJson = JSON.stringify(redirects, null, 2);
	const wxr = buildWxrFromSnapshot({ snapshot, protectedByKey, siteTitle, siteTagline, siteUrl: origin, now });

	const mediaRows = (snapshot.tables.media ?? []).filter(
		(row) => typeof row.storage_key === "string" && isSafeExportMediaKey(row.storage_key),
	);

	// Resolve signing secret once only if we might overflow media to signed URLs.
	const secrets = mediaRows.length > 0 && opts.storage ? await resolveSecrets({ db: opts.db }) : null;
	const expiresAtSec = Math.floor(now.getTime() / 1000) + ttlSec;
	const expiresAtIso = new Date(expiresAtSec * 1000).toISOString();
	const encoder = new TextEncoder();

	let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let driver: AsyncGenerator<void, void, void> | null = null;
	let enqueuedCount = 0;

	async function* driveExport(controller: ReadableStreamDefaultController<Uint8Array>): AsyncGenerator<void, void, void> {
		const z = new Zip((err, data, final) => {
			if (err) {
				controller.error(err);
				return;
			}
			if (data.byteLength > 0) {
				enqueuedCount++;
				controller.enqueue(data);
			}
			if (final) controller.close();
		});

		const pushText = (name: string, text: string): void => {
			const entry = new ZipDeflate(name, { level: 6 });
			z.add(entry);
			entry.push(encoder.encode(text), true);
		};

		pushText("emdash-backup.json", `${backupJson}\n`);
		yield;
		pushText("wordpress.xml", wxr.xml);
		yield;
		pushText("settings.json", `${settingsJson}\n`);
		yield;
		pushText("redirects.json", `${redirectsJson}\n`);
		yield;

		let inlineCount = 0;
		let inlineBytes = 0;
		const overflow: Array<{
			storageKey: string;
			filename: string;
			mimeType: string;
			size: number;
			url: string;
		}> = [];
		const missing: string[] = [];

		for (const row of mediaRows) {
			const storageKey = row.storage_key as string;
			const filename = typeof row.filename === "string" ? row.filename : storageKey;
			const mimeType = typeof row.mime_type === "string" ? row.mime_type : "application/octet-stream";
			const expectedSize = typeof row.size === "number" && Number.isFinite(row.size) ? row.size : 0;

			if (!opts.storage) {
				missing.push(storageKey);
				continue;
			}

			const fitsBudget =
				inlineCount < maxInlineFiles &&
				inlineBytes + expectedSize <= maxInlineBytes;

			if (fitsBudget) {
				let downloaded: Awaited<ReturnType<Storage["download"]>> | null = null;
				try {
					downloaded = await opts.storage.download(storageKey);
				} catch {
					missing.push(storageKey);
					continue;
				}

				if (inlineBytes + downloaded.size > maxInlineBytes) {
					await downloaded.body.cancel().catch(() => {});
					const url = await signExportMediaUrl({
						origin,
						key: storageKey,
						secret: secrets!.previewSecret,
						expiresAtSec,
					});
					overflow.push({ storageKey, filename, mimeType, size: downloaded.size, url });
					continue;
				}

				const pass = new ZipPassThrough(`uploads/${storageKey}`);
				z.add(pass);
				const reader = downloaded.body.getReader();
				activeReader = reader;
				let streamedBytes = 0;
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (value && value.byteLength > 0) {
							streamedBytes += value.byteLength;
							pass.push(value, false);
							yield;
						}
					}
				} finally {
					activeReader = null;
				}
				pass.push(new Uint8Array(0), true);
				inlineCount++;
				inlineBytes += streamedBytes;
				yield;
			} else {
				const url = await signExportMediaUrl({
					origin,
					key: storageKey,
					secret: secrets!.previewSecret,
					expiresAtSec,
				});
				overflow.push({ storageKey, filename, mimeType, size: expectedSize, url });
			}
		}

		if (overflow.length > 0) {
			pushText(
				"media-manifest.json",
				`${JSON.stringify({ expiresAt: expiresAtIso, items: overflow }, null, 2)}\n`,
			);
			yield;
		}

		const summary = {
			version: 1,
			exportedAt: now.toISOString(),
			siteUrl: origin,
			emdashVersion: VERSION,
			counts: {
				contentItems: wxr.itemCount,
				redirects: redirects.length,
				menus: (snapshot.tables._emdash_menus ?? []).length,
				protectedEntries: wxr.protectedEntries.length,
				mediaInline: inlineCount,
				mediaInlineBytes: inlineBytes,
				mediaOverflow: overflow.length,
				mediaMissing: missing.length,
			},
			protectedEntries: wxr.protectedEntries,
			media: {
				storageConfigured: Boolean(opts.storage),
				...(opts.storage ? {} : { note: "no storage configured" }),
				inline: inlineCount,
				inlineBytes,
				overflow: overflow.length,
				missing,
			},
			scrubbed: [
				"users",
				"sessions",
				"auth_tokens",
				"auth_challenges",
				"_emdash_api_tokens",
				"_emdash_oauth_tokens",
				"_emdash_device_codes",
				"_emdash_authorization_codes",
				"_emdash_protected_content.verifier",
				"_emdash_transfer_*",
				"emdash:preview_secret",
				"emdash:ip_salt",
				"emdash:passkey_pending:*",
				"plugin:*",
			],
		};
		pushText("export.json", `${JSON.stringify(summary, null, 2)}\n`);
		yield;
		pushText(
			"README.md",
			buildExportReadme({
				siteUrl: origin,
				exportedAt: now,
				contentCount: wxr.itemCount,
				redirectCount: redirects.length,
				inlineMediaCount: inlineCount,
				overflowMediaCount: overflow.length,
				missingMediaCount: missing.length,
				storageConfigured: Boolean(opts.storage),
				manifestExpiresAt: overflow.length > 0 ? expiresAtIso : null,
				protectedEntries: wxr.protectedEntries,
			}),
		);
		yield;

		z.end();
	}

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			driver ??= driveExport(controller);
			const before = enqueuedCount;
			try {
				while (enqueuedCount === before || (controller.desiredSize !== null && controller.desiredSize > 0)) {
					const step = await driver.next();
					if (step.done) break;
					if (controller.desiredSize !== null && controller.desiredSize <= 0) break;
				}
			} catch (err) {
				if (activeReader) {
					await activeReader.cancel().catch(() => {});
					activeReader = null;
				}
				controller.error(err);
			}
		},
		async cancel() {
			if (activeReader) {
				await activeReader.cancel().catch(() => {});
				activeReader = null;
			}
			if (driver) {
				await driver.return().catch(() => {});
				driver = null;
			}
		},
	});
}
