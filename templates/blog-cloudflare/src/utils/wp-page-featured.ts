import type { ImageValue } from "emdash";
import { htmlBlockHasImage } from "emdash/ui";

const MEDIA_PATH = "/_emdash/api/media/file/";
const SOURCE_IMAGE_KEY = /^[a-f0-9]{64}$/;
const IMAGE_URL_START = /^(?:https?:\/\/|\/(?!\/))/i;
const UNSAFE_URL_CHARACTER = /[\s\\]/u;
const LOCAL_ID = /^[a-z0-9_-]+$/i;

type Placement = "before-title" | "before-body" | "after-body";

export interface PageFeatured {
	placement: Placement;
	width: number;
	height: number;
	alt: string;
	/** Exact source upload identity, used only to skip an already-drawn shell copy. */
	sourceImage?: string;
	image: ImageValue;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function pixels(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function source(value: unknown): string | undefined {
	const s = text(value);
	if (!s || !IMAGE_URL_START.test(s) || UNSAFE_URL_CHARACTER.test(s)) return undefined;
	const url = URL.parse(s, "https://example.invalid");
	return url && !url.username && !url.password ? s : undefined;
}

function storageKey(value: Record<string, unknown>): string | undefined {
	return text(value.storageKey) ?? text(record(value.meta)?.storageKey);
}

export function readPageFeatured(data: unknown): PageFeatured | undefined {
	const page = record(data);
	const proof = record(page?.wp_page_featured);
	const fields = ["placement", "width", "height", "alt"];
	if (!proof || !fields.every((key) => Object.hasOwn(proof, key)) ||
		Object.keys(proof).some((key) => key !== "sourceImage" && !fields.includes(key))) {
		return undefined;
	}
	const { placement, width, height, alt, sourceImage } = proof;
	if (
		(placement !== "before-title" && placement !== "before-body" && placement !== "after-body") ||
		!pixels(width) ||
		!pixels(height) ||
		typeof alt !== "string" ||
		(sourceImage !== undefined && (typeof sourceImage !== "string" || !SOURCE_IMAGE_KEY.test(sourceImage)))
	) {
		return undefined;
	}

	const value = page?.featured_image;
	const asset = record(value);
	const rawSrc = asset ? asset.src : value;
	const src = source(rawSrc);
	if (rawSrc != null && !src) return undefined;
	const local = asset && (asset.provider === undefined || asset.provider === "local");
	const id = local ? text(asset.id) : undefined;
	const key = local ? storageKey(asset) : undefined;
	if (!src && !key && (!id || !LOCAL_ID.test(id))) return undefined;
	return {
		placement, width, height, alt, sourceImage,
		image: { id: id ?? "", src, meta: key ? { storageKey: key } : undefined },
	};
}

function mediaUrl(value: unknown, page: URL): URL | undefined {
	const src = source(value);
	const url = src && URL.parse(src, page);
	if (!url || url.username || url.password) return undefined;
	url.hash = "";
	return url;
}

function localKey(url: URL, page: URL): string | undefined {
	if (url.origin !== page.origin || !url.pathname.startsWith(MEDIA_PATH)) return undefined;
	try {
		return decodeURIComponent(url.pathname.slice(MEDIA_PATH.length)) || undefined;
	} catch {
		return undefined;
	}
}

export function pageFeaturedMatches(
	featured: PageFeatured,
	page: URL,
	publicMediaUrl?: (key: string) => string,
) {
	const { src, id, meta } = featured.image;
	const key = text(meta?.storageKey);
	const url = mediaUrl(src ?? (key && publicMediaUrl?.(key)), page);
	const keys = new Set([key, id, url && localKey(url, page)].filter(Boolean));
	return (candidate: unknown): boolean => {
		const address = mediaUrl(candidate, page);
		return !!address && (address.href === url?.href || keys.has(localKey(address, page)));
	};
}

export function bodyDrawsPageFeatured(
	body: unknown,
	matches: ReturnType<typeof pageFeaturedMatches>,
): boolean {
	function image(value: unknown): boolean {
		const asset = record(record(value)?.asset);
		if (!asset) return false;
		const src = text(asset.url) ?? text(asset.src);
		if (src) return matches(src);
		if (asset.provider !== undefined && asset.provider !== "local") return false;
		const key = storageKey(asset) ?? text(asset._ref) ?? text(asset.id);
		return !!key && matches(`${MEDIA_PATH}${key.split("/").map(encodeURIComponent).join("/")}`);
	}
	return Array.isArray(body) && body.some((value: unknown) => {
		const block = record(value);
		switch (block?._type) {
			case "image":
				return image(block);
			case "gallery":
				return Array.isArray(block.images) && block.images.some(image);
			case "cover":
				return (block.backgroundVideo == null && matches(block.backgroundImage)) ||
					bodyDrawsPageFeatured(block.content, matches);
			case "columns":
				return Array.isArray(block.columns) && block.columns.some((column: unknown) =>
					bodyDrawsPageFeatured(record(column)?.content, matches));
			case "htmlBlock":
				return typeof block.html === "string" && htmlBlockHasImage(block.html, matches);
			default:
				return false;
		}
	});
}
