/**
 * A post's featured image as an absolute URL, for the Open Graph fallback.
 * The image may have `src` (external) or `meta.storageKey` (local).
 */
export function featuredImageUrl(img: unknown, origin: string): string | undefined {
	if (!img || typeof img !== "object") return undefined;
	const image = img as Record<string, unknown>;
	if (typeof image.src === "string" && image.src) {
		return image.src.startsWith("http") ? image.src : `${origin}${image.src}`;
	}
	const meta = image.meta as Record<string, unknown> | undefined;
	const storageKey =
		(typeof meta?.storageKey === "string" ? meta.storageKey : undefined) ||
		(typeof image.id === "string" ? image.id : undefined);
	if (storageKey) {
		return `${origin}/_emdash/api/media/file/${storageKey}`;
	}
	return undefined;
}
