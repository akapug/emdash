const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A post's featured image as an absolute URL, for the Open Graph fallback.
 * The image may have `src` (external) or `meta.storageKey` (local).
 */
export function featuredImageUrl(img: unknown, origin: string): string | undefined {
	if (!isRecord(img)) return undefined;
	if (typeof img.src === "string" && img.src) {
		return img.src.startsWith("http") ? img.src : `${origin}${img.src}`;
	}
	const meta = isRecord(img.meta) ? img.meta : undefined;
	const storageKey =
		(typeof meta?.storageKey === "string" ? meta.storageKey : undefined) ||
		(typeof img.id === "string" ? img.id : undefined);
	if (storageKey) {
		return `${origin}/_emdash/api/media/file/${storageKey}`;
	}
	return undefined;
}
