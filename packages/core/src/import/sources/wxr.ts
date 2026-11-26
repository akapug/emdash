/**
 * WXR (WordPress eXtended RSS) import source
 *
 * Handles WordPress export file uploads (.xml).
 * This wraps the existing WXR parsing and analysis logic.
 */

import {
	gutenbergToPortableText,
	texturizeNote,
	texturizes,
	wptexturize,
} from "@emdash-cms/gutenberg-to-portable-text";

import { parseWxrString, type WxrData, type WxrPost } from "../../cli/wxr/parser.js";
import { importProtection } from "../protection.js";
import type {
	ImportSource,
	ImportAnalysis,
	ImportContext,
	SourceInput,
	FetchOptions,
	NormalizedItem,
	PostTypeAnalysis,
	AttachmentInfo,
	NavMenuAnalysis,
	TaxonomyAnalysis,
	ReusableBlockAnalysis,
} from "../types.js";
import {
	BASE_REQUIRED_FIELDS,
	FEATURED_IMAGE_FIELD,
	isInternalPostType,
	isInternalMetaKey,
	mapWpStatus,
	isPasswordProtected,
	mapPostTypeToCollection,
	mapMetaKeyToField,
	inferMetaType,
	slugify,
	buildAttachmentMap,
	getFilenameFromUrl,
	guessMimeType,
	checkSchemaCompatibility,
	relativizeContentLinks,
} from "../utils.js";

export const wxrSource: ImportSource = {
	id: "wxr",
	name: "WordPress Export File",
	description: "Upload a WordPress export file (.xml)",
	icon: "upload",
	requiresFile: true,
	canProbe: false,

	async analyze(input: SourceInput, context: ImportContext): Promise<ImportAnalysis> {
		if (input.type !== "file") {
			throw new Error("WXR source requires a file input");
		}

		const text = await input.file.text();
		const wxr = await parseWxrString(text);

		// Get existing collections for schema compatibility check
		const existingCollections = context.getExistingCollections
			? await context.getExistingCollections()
			: new Map();

		return analyzeWxrData(wxr, existingCollections);
	},

	async *fetchContent(input: SourceInput, options: FetchOptions): AsyncGenerator<NormalizedItem> {
		if (input.type !== "file") {
			throw new Error("WXR source requires a file input");
		}

		const text = await input.file.text();
		const wxr = await parseWxrString(text);

		// Build attachment ID -> URL map for resolving featured images
		const attachmentMap = buildAttachmentMap(wxr.attachments);

		let count = 0;
		for (const post of wxr.posts) {
			const postType = post.postType || "post";

			// Skip if not in requested post types
			if (!options.postTypes.includes(postType)) {
				continue;
			}

			// Skip internal post types
			if (isInternalPostType(postType)) {
				continue;
			}

			// Skip drafts if not requested
			if (!options.includeDrafts && post.status !== "publish") {
				continue;
			}

			const access = await importProtection(post, options);
			const normalized = wxrPostToNormalizedItem(
				post,
				attachmentMap,
				wxr.site.link || "",
				wxr.site.language,
				wxr.site.generator,
			);
			if (access.protected) {
				normalized.status = access.protection ? mapWpStatus(post.status) : "draft";
				if (access.protection) normalized.protection = access.protection;
			}
			yield normalized;

			count++;
			if (options.limit && count >= options.limit) {
				break;
			}
		}
	},
};

/**
 * Analyze WXR data and return normalized ImportAnalysis
 */
function analyzeWxrData(
	wxr: WxrData,
	existingCollections: Map<string, { slug: string; fields: Map<string, { type: string }> }>,
): ImportAnalysis {
	// Count post types and track which have featured images
	const postTypeCounts = new Map<string, number>();
	const postTypesWithThumbnails = new Set<string>();
	const metaKeys = new Map<string, { count: number; samples: string[]; isInternal: boolean }>();
	const authorPostCounts = new Map<string, number>();

	for (const post of wxr.posts) {
		const type = post.postType || "post";
		postTypeCounts.set(type, (postTypeCounts.get(type) || 0) + 1);

		// Count posts per author (by login)
		if (post.creator) {
			authorPostCounts.set(post.creator, (authorPostCounts.get(post.creator) || 0) + 1);
		}

		// Track if this post type has featured images
		if (post.meta.has("_thumbnail_id")) {
			postTypesWithThumbnails.add(type);
		}

		// Analyze meta keys
		for (const [key, value] of post.meta) {
			const existing = metaKeys.get(key);
			if (existing) {
				existing.count++;
				if (existing.samples.length < 3 && value) {
					existing.samples.push(value.slice(0, 100));
				}
			} else {
				metaKeys.set(key, {
					count: 1,
					samples: value ? [value.slice(0, 100)] : [],
					isInternal: isInternalMetaKey(key),
				});
			}
		}
	}

	// Map meta keys to fields (for custom fields analysis)
	const customFields = [...metaKeys.entries()]
		.filter(([_, info]) => !info.isInternal)
		.map(([key, info]) => ({
			key,
			count: info.count,
			samples: info.samples,
			suggestedField: mapMetaKeyToField(key),
			suggestedType: inferMetaType(key, info.samples[0]),
			isInternal: info.isInternal,
		}))
		.toSorted((a, b) => b.count - a.count);

	// Build post type analysis with schema compatibility
	const postTypes: PostTypeAnalysis[] = [...postTypeCounts.entries()]
		.filter(([type]) => !isInternalPostType(type))
		.map(([name, count]) => {
			const suggestedCollection = mapPostTypeToCollection(name);
			const existingCollection = existingCollections.get(suggestedCollection);

			// Build required fields - add featured_image only if posts have thumbnails
			const requiredFields = [...BASE_REQUIRED_FIELDS];
			if (postTypesWithThumbnails.has(name)) {
				requiredFields.push(FEATURED_IMAGE_FIELD);
			}

			const schemaStatus = checkSchemaCompatibility(requiredFields, existingCollection);

			return {
				name,
				count,
				suggestedCollection,
				requiredFields,
				schemaStatus,
			};
		})
		.toSorted((a, b) => b.count - a.count);

	// Build attachment info list
	const attachmentItems: AttachmentInfo[] = wxr.attachments.map((att) => {
		const filename = att.url ? getFilenameFromUrl(att.url) : undefined;
		const mimeType = filename ? guessMimeType(filename) : undefined;
		return {
			id: att.id,
			title: att.title,
			url: att.url,
			filename,
			mimeType,
		};
	});

	// Analyze navigation menus
	const navMenus: NavMenuAnalysis[] = wxr.navMenus.map((menu) => ({
		name: menu.name,
		label: menu.label,
		itemCount: menu.items.length,
	}));

	// Analyze custom taxonomies (from wp:term elements, excluding category/post_tag/nav_menu)
	const taxonomyMap = new Map<string, { count: number; samples: string[] }>();
	for (const term of wxr.terms) {
		if (
			term.taxonomy === "category" ||
			term.taxonomy === "post_tag" ||
			term.taxonomy === "nav_menu"
		) {
			continue;
		}

		const existing = taxonomyMap.get(term.taxonomy);
		if (existing) {
			existing.count++;
			if (existing.samples.length < 3) {
				existing.samples.push(term.name);
			}
		} else {
			taxonomyMap.set(term.taxonomy, {
				count: 1,
				samples: [term.name],
			});
		}
	}

	const customTaxonomies: TaxonomyAnalysis[] = Array.from(
		taxonomyMap.entries(),
		([slug, info]) => ({
			slug,
			termCount: info.count,
			sampleTerms: info.samples,
		}),
	).toSorted((a, b) => b.termCount - a.termCount);

	// Analyze reusable blocks (wp_block post type)
	const reusableBlocks: ReusableBlockAnalysis[] = wxr.posts
		.filter((post) => post.postType === "wp_block")
		.map((post) => ({
			id: post.id || 0,
			title: post.title || "Untitled Block",
			slug: post.postName || slugify(post.title || `block-${post.id || Date.now()}`),
		}));

	return {
		sourceId: "wxr",
		site: {
			title: wxr.site.title || "WordPress Site",
			url: wxr.site.link || "",
		},
		typography: {
			language: wxr.site.language?.trim() || null,
			texturized: texturizes(wxr.site.language, wxr.site.generator),
			note: texturizeNote(wxr.site.language, wxr.site.generator),
		},
		postTypes,
		attachments: {
			count: wxr.attachments.length,
			items: attachmentItems,
		},
		categories: wxr.categories.length,
		tags: wxr.tags.length,
		authors: wxr.authors.map((a) => ({
			id: a.id,
			login: a.login,
			email: a.email,
			displayName: a.displayName || a.login || "Unknown",
			postCount: a.login ? authorPostCounts.get(a.login) || 0 : 0,
		})),
		navMenus: navMenus.length > 0 ? navMenus : undefined,
		customTaxonomies: customTaxonomies.length > 0 ? customTaxonomies : undefined,
		reusableBlocks: reusableBlocks.length > 0 ? reusableBlocks : undefined,
		customFields,
	};
}

/**
 * Convert a WXR post to a normalized item
 */
function wxrPostToNormalizedItem(
	post: WxrPost,
	attachmentMap: Map<string, string>,
	siteUrl: string,
	siteLanguage?: string,
	generator?: string,
): NormalizedItem {
	// As WordPress printed it, in English (texturizes); a post's own locale decides for it,
	// and an export another program wrote is stored as written.
	const texturize = texturizes(post.locale ?? siteLanguage, generator);
	const typed = (text: string) => (texturize ? wptexturize(text) : text);
	// Item 163c: the converter tells us what it decided about each unknown page-builder container, so the import report can say
	// how many sections kept their layout and how many were flattened. Collected per post here, summed by the caller.
	const containerEvents: Array<{
		blockName: string | null;
		outcome: "kept" | "flat";
		droppedNoMarkup?: string[];
	}> = [];
	const content = post.content
		? gutenbergToPortableText(post.content, {
				texturize,
				onContainer: (event) => containerEvents.push(event),
			})
		: [];
	if (siteUrl) relativizeContentLinks(content, siteUrl);

	// Item 163c: the containers this body held, so the import can report kept-vs-flat across the whole run.
	const containers = containerEvents.length > 0 ? containerEvents : undefined;

	// Resolve featured image: _thumbnail_id is the attachment ID, look up the URL
	const thumbnailId = post.meta.get("_thumbnail_id");
	const featuredImage = thumbnailId ? attachmentMap.get(String(thumbnailId)) : undefined;

	// Convert custom taxonomies Map to Record.
	// Strip Polylang's `language` taxonomy -- the parser already promoted it
	// to `post.locale`, and exposing it as a content taxonomy here would
	// (a) try to insert a `language` taxonomy on EmDash that doesn't exist
	// and (b) duplicate the locale signal in two places.
	let customTaxonomies: Record<string, string[]> | undefined;
	if (post.customTaxonomies && post.customTaxonomies.size > 0) {
		const filtered = Object.fromEntries(
			[...post.customTaxonomies].filter(([taxonomy]) => taxonomy !== "language"),
		);
		if (Object.keys(filtered).length > 0) {
			customTaxonomies = filtered;
		}
	}

	return {
		sourceId: post.id || 0,
		postType: post.postType || "post",
		// Unverified consumers retain the draft fallback; fetchContent can opt into private storage.
		status: isPasswordProtected(post) ? "draft" : mapWpStatus(post.status),
		slug: post.postName || slugify(post.title || `post-${post.id || Date.now()}`),
		// As WordPress printed them, like the content (wptexturize); the slug is the stored title's.
		title: typed(post.title || "Untitled"),
		content,
		...(containers ? { containers } : {}),
		excerpt: post.excerpt ? typed(post.excerpt) : post.excerpt,
		date: parseWxrDate(post.postDateGmt, post.pubDate, post.postDate) ?? new Date(),
		modified: parseWxrDate(post.postModifiedGmt, undefined, post.postModified),
		author: post.creator,
		categories: post.categories,
		tags: post.tags,
		meta: Object.fromEntries(post.meta),
		featuredImage,
		// Hierarchical content support
		parentId: post.postParent && post.postParent !== 0 ? post.postParent : undefined,
		menuOrder: post.menuOrder,
		// Custom taxonomy assignments
		customTaxonomies,
		// Multilingual plugin metadata (WPML / Polylang) promoted by the parser.
		// When absent, the caller (e.g. execute route) falls back to the
		// upload-wide locale.
		locale: post.locale,
		translationGroup: post.translationGroup,
	};
}

/**
 * WordPress uses "0000-00-00 00:00:00" as a sentinel for missing GMT dates
 * (e.g. unpublished drafts). This must be treated as absent.
 */
export const WXR_ZERO_DATE = "0000-00-00 00:00:00";

/**
 * Parse a WXR date with the correct fallback chain:
 * 1. GMT date (always UTC, most reliable)
 * 2. pubDate (RFC 2822, includes timezone offset)
 * 3. Site-local date (MySQL datetime without timezone, imprecise but best available)
 *
 * Returns undefined when none of the inputs yield a valid date.
 * Callers that need a guaranteed Date should use `?? new Date()`.
 */
const ZONED_OFFSET_PATTERN = /(?:[+-]\d{2}:?\d{2}|\b(?:GMT|UTC)\b|Z)\s*$/i;

function isZeroWxrDate(raw: string): boolean {
	return raw.startsWith("0000-00-00");
}

export function parseWxrDate(
	gmtDate: string | undefined,
	pubDate: string | undefined,
	localDate: string | undefined,
): Date | undefined {
	const gmt = typeof gmtDate === "string" ? gmtDate.trim() : "";
	if (gmt && gmt !== WXR_ZERO_DATE && !isZeroWxrDate(gmt)) {
		// GMT dates from WordPress are "YYYY-MM-DD HH:MM:SS" in UTC.
		// Append "Z" so the JS Date constructor treats them as UTC.
		const d = new Date(gmt.includes("T") ? gmt : `${gmt.replace(" ", "T")}Z`);
		if (!Number.isNaN(d.getTime())) return d;
	}

	const pub = typeof pubDate === "string" ? pubDate.trim() : "";
	if (pub && !isZeroWxrDate(pub)) {
		// RFC 2822 format includes timezone offset, JS Date parses it correctly
		const d = new Date(pub);
		if (!Number.isNaN(d.getTime())) return d;
	}

	const local = typeof localDate === "string" ? localDate.trim() : "";
	if (local && local !== WXR_ZERO_DATE && !isZeroWxrDate(local)) {
		// Site-local time without timezone. Normalize to ISO-like form so
		// runtimes that reject "YYYY-MM-DD HH:MM:SS" can still parse it as
		// local time. If parsing still fails, return undefined.
		const d = new Date(local.replace(" ", "T"));
		if (!Number.isNaN(d.getTime())) return d;
	}

	return undefined;
}

/**
 * Parse a scheduling moment for a WordPress `future` post.
 *
 * ONLY a zoned moment may schedule a post:
 * 1. `postDateGmt` (UTC, non-zero, valid)
 * 2. `pubDate` carrying an explicit timezone offset or GMT/UTC/Z
 *
 * A site-local `postDate` without a timezone is NEVER silently treated as UTC:
 * it returns `{ date: null, unzonedLocalOnly: true }` so the caller keeps the
 * post as a draft and names it.
 */
export function parseScheduledWxrDate(
	gmtDate: string | undefined,
	pubDate: string | undefined,
	localDate: string | undefined,
): { date: Date | null; unzonedLocalOnly: boolean } {
	const gmt = typeof gmtDate === "string" ? gmtDate.trim() : "";
	if (gmt && gmt !== WXR_ZERO_DATE && !isZeroWxrDate(gmt)) {
		const d = new Date(gmt.includes("T") ? gmt : `${gmt.replace(" ", "T")}Z`);
		if (!Number.isNaN(d.getTime())) return { date: d, unzonedLocalOnly: false };
	}

	const pub = typeof pubDate === "string" ? pubDate.trim() : "";
	if (pub && !isZeroWxrDate(pub) && ZONED_OFFSET_PATTERN.test(pub)) {
		const d = new Date(pub);
		if (!Number.isNaN(d.getTime())) return { date: d, unzonedLocalOnly: false };
	}

	const local = typeof localDate === "string" ? localDate.trim() : "";
	if (local && local !== WXR_ZERO_DATE && !isZeroWxrDate(local)) {
		const d = new Date(local.replace(" ", "T"));
		if (!Number.isNaN(d.getTime())) return { date: null, unzonedLocalOnly: true };
	}

	return { date: null, unzonedLocalOnly: false };
}

// Export for use in other sources
export { analyzeWxrData, wxrPostToNormalizedItem };

// Re-export shared utilities that other sources may need
export {
	BASE_REQUIRED_FIELDS,
	FEATURED_IMAGE_FIELD,
	mapPostTypeToCollection,
	isInternalPostType,
	checkSchemaCompatibility,
} from "../utils.js";
