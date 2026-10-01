/**
 * Site Settings Types
 *
 * Global configuration for the site (title, logo, social links, etc.)
 */

/**
 * Media reference for logo/favicon/seo.defaultOgImage.
 *
 * Stored shape is just `{ mediaId, alt? }`. The remaining fields are
 * populated by `resolveMediaReference` on read so templates can emit
 * correct head tags without a second round-trip to the media table.
 *
 * The Zod schemas at the REST/MCP boundary are split:
 *  - `mediaReferenceInput` (used by `settingsUpdateBody`) defines only
 *    `mediaId` and `alt`. Default strip-mode parsing discards any
 *    resolved fields a client posts back, so they never reach storage.
 *  - `mediaReferenceResponse` (used by `siteSettingsSchema`) includes
 *    the resolved fields so generated OpenAPI clients see them.
 *
 * If you ever switch `mediaReferenceInput` to `passthrough`, you must
 * also strip the resolved fields explicitly in `setSiteSettings`, or
 * stored options will accumulate stale `url` / `contentType` / `width`
 * / `height` snapshots.
 */
export interface MediaReference {
	mediaId: string;
	alt?: string;
	/** Resolved URL. Populated by `resolveMediaReference`; absent on raw stored values. */
	url?: string;
	/** Stored MIME type (e.g. `image/svg+xml`). Populated alongside `url`. */
	contentType?: string;
	/** Pixel width if known. Populated alongside `url`. */
	width?: number;
	/** Pixel height if known. Populated alongside `url`. */
	height?: number;
}

/** Site-level SEO settings */
export interface SeoSettings {
	/** Separator between page title and site title (e.g., " | ", " — ") */
	titleSeparator?: string;
	/** Default OG image when content has no seo_image */
	defaultOgImage?: MediaReference;
	/** Custom robots.txt content. If unset, a default is generated. */
	robotsTxt?: string;
	/** Google Search Console verification meta tag content */
	googleVerification?: string;
	/** Bing Webmaster Tools verification meta tag content */
	bingVerification?: string;
}

/**
 * The entry a site shows at its root URL instead of its latest posts.
 *
 * `id` is the entry's translation group, so the reference names the entry in
 * every locale rather than one locale's row. Writes accept the id of any
 * translation and store its group.
 */
export interface HomepageReference {
	collection: string;
	id: string;
	/**
	 * The translation an editor should see for this reference. Populated by
	 * the settings API on read; absent on raw stored values and ignored on
	 * write. `null` when the group has no live translation left.
	 */
	entry?: HomepageEntry | null;
}

/**
 * One live translation of a homepage reference: the published one a visitor
 * sees at the root, else the first by the same order.
 */
export interface HomepageEntry {
	id: string;
	locale: string | null;
	status: string;
}

/** Site settings schema */
export interface SiteSettings {
	// Identity
	title: string;
	tagline?: string;
	logo?: MediaReference;
	favicon?: MediaReference;

	// URLs
	url?: string;

	// Display
	homepage?: HomepageReference;
	postsPerPage: number;
	dateFormat: string;
	timezone: string;

	// Social
	social?: {
		twitter?: string;
		github?: string;
		facebook?: string;
		instagram?: string;
		linkedin?: string;
		youtube?: string;
	};

	// SEO
	seo?: SeoSettings;

	// Embeds
	/**
	 * Hosts this site's content may embed iframes from, beyond YouTube and
	 * Vimeo: exact lowercase hostnames, no wildcard, scheme or port. An iframe
	 * from one of them is kept only when its src is https.
	 */
	iframeHosts?: string[];
}

/** Partial SEO update. `null` removes the configured default image. */
export interface SeoSettingsUpdate extends Omit<SeoSettings, "defaultOgImage"> {
	defaultOgImage?: MediaReference | null;
}

/**
 * Site-settings write shape. `null` removes media references and the homepage;
 * omitted fields are unchanged.
 */
export interface SiteSettingsUpdate extends Omit<
	Partial<SiteSettings>,
	"logo" | "favicon" | "homepage" | "seo"
> {
	logo?: MediaReference | null;
	favicon?: MediaReference | null;
	homepage?: HomepageReference | null;
	seo?: SeoSettingsUpdate;
}

/** Keys that are valid site settings */
export type SiteSettingKey = keyof SiteSettings;
