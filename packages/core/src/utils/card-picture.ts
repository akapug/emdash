/**
 * Which picture a POST CARD draws.
 *
 * MEASURED, on a real imported site, card for card against the live theme: six of six cards drew exactly the FIRST
 * picture of that post's own content, and zero of 45 published posts carried a `_thumbnail_id`. The theme's card
 * picture is not a featured image there — it is the first picture in the body. That is the spec this file encodes,
 * because a card that follows it shows what the live site showed.
 *
 * ORDER, as the lead specified: the post's featured image; else the first picture in its content, walking the
 * STORED content in document order (an image node, a gallery's first image, a cover's background, or the first
 * `<img>` inside an htmlBlock); else nothing, and the card draws what it draws today.
 *
 * WHY THE HTMLBLOCK GUARDS EXIST. A body's raw HTML is a full email: inline CSS, spacer GIFs, tracking pixels.
 * The measurement above says the FIRST `<img>` was the real picture in all 44 posts that had one — but that is a
 * fact about ONE site's theme, not a law, so an `<img>` is only taken when it looks like a picture at all.
 */
import { attributesOf } from "./raw-media-tags.js";

/** What a card needs: where the picture is, and the alt to draw with it. */
export interface CardPicture {
	src: string;
	alt?: string;
	/** A ref for a stored media asset, when the node carries one (drawn through the image component). */
	assetRef?: string;
}

/** A picture is a source and nothing more; the card decides how to draw it. */
const isUsableSource = (src: string | undefined): src is string => {
	if (!src) return false;
	// ONE RULE COVERS THEM ALL, and an arm proved it: a data:, javascript: or blob: source matches none of these
	// prefixes, so it is rejected here. A separate `data:` branch was written first and could never fire — removed
	// rather than kept as a guard that does nothing.
	return /^(https?:\/\/|\/)/i.test(src);
};

/**
 * Is this `width`/`height` attribute the 1px trick (a spacer or a tracker)?
 *
 * A missing attribute is NOT a reason to skip: a real picture very often carries neither. An attribute that IS
 * present and says 1 or 0 is decisive — that tag draws nothing a person sees.
 */
const looksLikeTracker = (attributes: Map<string, string>): boolean => {
	for (const name of ["width", "height"]) {
		const raw = attributes.get(name)?.trim();
		if (raw && /^\d+$/.test(raw)) {
			const value = Number(raw);
			if (value <= 1) return true;
		}
	}
	return false;
};

/** The first picture in a run of raw HTML, or null. */
export function pictureInHtml(html: string | undefined): CardPicture | null {
	if (!html) return null;
	for (const match of html.matchAll(/<img\b(?:[^>"'=]|=\s*"[^"]*"|=\s*'[^']*'|=)*>/gi)) {
		const attributes = attributesOf(match[0]);
		const src = attributes.get("src");
		if (!isUsableSource(src)) continue;
		if (looksLikeTracker(attributes)) continue;
		return { src, alt: attributes.get("alt") || undefined };
	}
	return null;
}

/** One Portable Text node's first picture, without looking inside it. */
function pictureInNode(node: Record<string, unknown>): CardPicture | null {
	switch (node._type) {
		case "image": {
			const asset = node.asset as { _ref?: string; url?: string } | undefined;
			const alt = typeof node.alt === "string" && node.alt ? node.alt : undefined;
			// A stored asset is drawn through the image component by its ref; an external one by its url.
			if (asset?._ref) return { src: asset.url ?? "", alt, assetRef: asset._ref };
			if (isUsableSource(asset?.url)) return { src: asset.url, alt };
			return null;
		}
		case "gallery": {
			const images = Array.isArray(node.images) ? node.images : [];
			for (const image of images) {
				if (!image || typeof image !== "object") continue;
				const found = pictureInNode(image as Record<string, unknown>);
				if (found) return found;
			}
			return null;
		}
		case "cover": {
			const background = node.backgroundImage ?? node.background;
			if (typeof background === "string" && isUsableSource(background)) {
				return { src: background, alt: typeof node.alt === "string" ? node.alt : undefined };
			}
			return null;
		}
		case "htmlBlock":
			return pictureInHtml(typeof node.html === "string" ? node.html : undefined);
		default:
			return null;
	}
}

/**
 * The picture a card draws for a post.
 *
 * `content` is the stored Portable Text, walked in document order. A container that holds blocks (columns, a
 * cover's content) is descended into, so a picture nested one level down is still found.
 */
export function cardPicture(
	post: { featuredImage?: unknown; content?: unknown },
	options: { pick?: (node: Record<string, unknown>) => CardPicture | null } = {},
): CardPicture | null {
	// The featured image wins where it is set. It is a string (a url) or an object with `url`/`asset`.
	const featured = post.featuredImage;
	if (typeof featured === "string" && isUsableSource(featured)) return { src: featured };
	if (featured && typeof featured === "object") {
		const record = featured as Record<string, unknown>;
		const url = record.url ?? (record.asset as { url?: string } | undefined)?.url;
		if (isUsableSource(typeof url === "string" ? url : undefined)) return { src: url as string };
	}

	const pick = options.pick ?? pictureInNode;
	const blocks = Array.isArray(post.content) ? post.content : [];
	const queue = [...blocks] as Array<Record<string, unknown> | undefined>;
	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || typeof node !== "object") continue;
		const found = pick(node);
		if (found) return found;
		// DOCUMENT ORDER means a container's own children come before the next sibling block, so they go to the
		// FRONT of the queue.
		const children = node.content;
		if (Array.isArray(children)) queue.unshift(...(children as Array<Record<string, unknown>>));
	}
	return null;
}
