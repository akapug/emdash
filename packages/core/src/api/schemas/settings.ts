import { z } from "zod";

import { isIframeHostname } from "../../utils/iframe-hosts.js";
import { httpUrl } from "./common.js";

// ---------------------------------------------------------------------------
// Settings: Input schemas
//
// Media references on write are just `{ mediaId, alt? }` -- the resolved
// fields (`url`, `contentType`, `width`, `height`) are server-computed and
// stripped from any submitted body via Zod's default strip mode. See
// `packages/core/src/settings/types.ts` for the in-memory shape.
// ---------------------------------------------------------------------------

const mediaReferenceInput = z.object({
	mediaId: z.string(),
	alt: z.string().optional(),
});

const socialSettings = z.object({
	twitter: z.string().optional(),
	github: z.string().optional(),
	facebook: z.string().optional(),
	instagram: z.string().optional(),
	linkedin: z.string().optional(),
	youtube: z.string().optional(),
});

const homepageReference = z.object({
	collection: z.string().min(1),
	id: z.string().min(1),
});

const seoSettingsInput = z.object({
	titleSeparator: z.string().max(10).optional(),
	defaultOgImage: mediaReferenceInput.nullable().optional(),
	robotsTxt: z.string().max(5000).optional(),
	googleVerification: z.string().max(100).optional(),
	bingVerification: z.string().max(100).optional(),
});

/**
 * The site's own iframe hosts: each an exact lowercase hostname (no wildcard,
 * scheme, port or path), added to the defaults at render time, never in place
 * of them.
 */
export const iframeHostsSetting = z
	.array(
		z
			.string()
			.refine(
				isIframeHostname,
				"Must be an exact lowercase hostname: no wildcard, scheme, port or path",
			),
	)
	.max(100);

export const settingsUpdateBody = z
	.object({
		title: z.string().optional(),
		tagline: z.string().optional(),
		logo: mediaReferenceInput.nullable().optional(),
		favicon: mediaReferenceInput.nullable().optional(),
		url: z.union([httpUrl, z.literal("")]).optional(),
		homepage: homepageReference.nullable().optional(),
		postsPerPage: z.number().int().min(1).max(100).optional(),
		dateFormat: z.string().optional(),
		timezone: z.string().optional(),
		social: socialSettings.optional(),
		seo: seoSettingsInput.optional(),
		iframeHosts: iframeHostsSetting.optional(),
	})
	.meta({ id: "SettingsUpdateBody" });

// ---------------------------------------------------------------------------
// Settings: Response schemas
//
// Responses carry the resolved fields populated by `resolveMediaReference`
// in `settings/index.ts`. Generated OpenAPI clients need to see them so
// they don't have to re-resolve the URL on the client. Fields stay
// optional because the resolver returns the bare ref if the underlying
// media row was deleted (orphaned reference).
// ---------------------------------------------------------------------------

const mediaReferenceResponse = z.object({
	mediaId: z.string(),
	alt: z.string().optional(),
	/** Resolved media file URL; absent if the underlying row is missing. */
	url: z.string().optional(),
	/** Stored MIME type (e.g. `image/svg+xml`). Populated alongside `url`. */
	contentType: z.string().optional(),
	/** Pixel width if known. Populated alongside `url`. */
	width: z.number().int().optional(),
	/** Pixel height if known. Populated alongside `url`. */
	height: z.number().int().optional(),
});

const homepageResponse = homepageReference.extend({
	/**
	 * The translation of the homepage a visitor sees at the root: the published
	 * one that comes first in the default locale's fallback chain, then by
	 * locale code. With none published, the first by that order. `null` when no
	 * translation is left. Resolved on read; never stored.
	 */
	entry: z
		.object({ id: z.string(), locale: z.string().nullable(), status: z.string() })
		.nullable()
		.optional(),
});

const seoSettingsResponse = z.object({
	titleSeparator: z.string().max(10).optional(),
	defaultOgImage: mediaReferenceResponse.optional(),
	robotsTxt: z.string().max(5000).optional(),
	googleVerification: z.string().max(100).optional(),
	bingVerification: z.string().max(100).optional(),
});

export const siteSettingsSchema = z
	.object({
		title: z.string().optional(),
		tagline: z.string().optional(),
		logo: mediaReferenceResponse.optional(),
		favicon: mediaReferenceResponse.optional(),
		url: z.string().optional(),
		homepage: homepageResponse.optional(),
		postsPerPage: z.number().int().optional(),
		dateFormat: z.string().optional(),
		timezone: z.string().optional(),
		social: socialSettings.optional(),
		seo: seoSettingsResponse.optional(),
		iframeHosts: z.array(z.string()).optional(),
	})
	.meta({ id: "SiteSettings" });
