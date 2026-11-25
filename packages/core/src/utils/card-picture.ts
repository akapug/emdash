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

/** A root-relative path or an absolute http(s) url — a `data:`, `javascript:` or `blob:` source matches neither. */
const USABLE_SOURCE = /^(https?:\/\/|\/)/i;

/** A dimension attribute a browser would honour as a number. */
const DIMENSION = /^\d+$/;

/** An `<img …>` tag, whole; a quoted value is consumed as a unit so a `>` inside an alt does not end it. */
const IMG_TAG = /<img\b(?:[^>"'=]|=\s*"[^"]*"|=\s*'[^']*'|=)*>/gi;

/**
 * The value as a record, or null. No assertion: the runtime check IS the narrowing — a non-null object is a
 * record as far as this file is concerned, and every property it reads is checked for its type at the read.
 */
const asRecord = (value: unknown): { readonly [key: string]: unknown } | null =>
	typeof value === "object" && value !== null ? Object(value) : null;

/** A picture is a source and nothing more; the card decides how to draw it. */
const isUsableSource = (src: string | undefined): src is string => {
	if (!src) return false;
	// ONE RULE COVERS THEM ALL, and an arm proved it: a data:, javascript: or blob: source matches none of these
	// prefixes, so it is rejected here. A separate `data:` branch was written first and could never fire — removed
	// rather than kept as a guard that does nothing.
	return USABLE_SOURCE.test(src);
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
		if (raw && DIMENSION.test(raw)) {
			const value = Number(raw);
			if (value <= 1) return true;
		}
	}
	return false;
};

/** The first picture in a run of raw HTML, or null. */
export function pictureInHtml(html: string | undefined): CardPicture | null {
	if (!html) return null;
	for (const match of html.matchAll(IMG_TAG)) {
		const attributes = attributesOf(match[0]);
		const src = attributes.get("src");
		if (!isUsableSource(src)) continue;
		if (looksLikeTracker(attributes)) continue;
		return { src, alt: attributes.get("alt") || undefined };
	}
	return null;
}

/** One Portable Text node's first picture, without looking inside it. */
function pictureInNode(node: { readonly [key: string]: unknown }): CardPicture | null {
	switch (node._type) {
		case "image": {
			const asset = asRecord(node.asset);
			const alt = typeof node.alt === "string" && node.alt ? node.alt : undefined;
			const ref = typeof asset?._ref === "string" ? asset._ref : undefined;
			const url = typeof asset?.url === "string" ? asset.url : undefined;
			// A STORED ASSET IS DRAWN BY ITS REF, AND THE REF IS ALREADY THE ROUTE.
			//
			// MEASURED on a real post (optest-dreamingstone-ac, ec_posts, 2024-annual-report): an image node's
			// asset is `{ _type: "reference", _ref: "/_emdash/api/media/file/01M883…jpeg", url: <the same> }`.
			// The ref is a FULL PATH, not a bare id — so a caller that prefixes the route to it produces
			// `/_emdash/api/media/file//_emdash/api/media/file/01M883…jpeg`, a doubled path that 404s every card.
			// The ref is kept verbatim and named for what it is.
			if (ref) return { src: url ?? "", alt, assetRef: ref };
			if (isUsableSource(url)) return { src: url, alt };
			return null;
		}
		case "gallery": {
			const images: unknown[] = Array.isArray(node.images) ? node.images : [];
			for (const image of images) {
				const record = asRecord(image);
				if (!record) continue;
				const found = pictureInNode(record);
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
	options: {
		pick?: (node: { readonly [key: string]: unknown }) => CardPicture | null;
		/**
		 * Walk the post's content and draw its first picture when there is no featured image.
		 *
		 * OFF BY DEFAULT, AND ONLY A SITE'S OWN LISTING SHOULD TURN IT ON. Measured on three real sources: one draws
		 * nothing for a card without a featured image, one draws a content picture for every card it shows, and one
		 * never displays the case. A default here would be one site's answer applied to another site's pages.
		 */
		contentFirst?: boolean;
	} = {},
): CardPicture | null {
	// The featured image wins where it is set. It is a string (a url) or an object with `url`/`asset`.
	const featured = post.featuredImage;
	if (typeof featured === "string" && isUsableSource(featured)) return { src: featured };
	const featuredRecord = asRecord(featured);
	if (featuredRecord) {
		const own = typeof featuredRecord.url === "string" ? featuredRecord.url : undefined;
		const viaAsset = asRecord(featuredRecord.asset);
		const assetUrl = typeof viaAsset?.url === "string" ? viaAsset.url : undefined;
		const url = own ?? assetUrl;
		if (isUsableSource(url)) return { src: url };
		// A STORED REFERENCE IS A PICTURE TOO. A `featured_image` row can hold the media reference and nothing else —
		// measured on a real post, where an image node's asset is `{ _ref: "/_emdash/api/media/file/<id>.<ext>" }` with
		// no `url` beside it — and a card that ignored the ref would draw nothing for an image the site clearly has.
		const viaRef = typeof viaAsset?._ref === "string" ? viaAsset._ref : undefined;
		if (viaRef && isUsableSource(viaRef)) return { src: viaRef, assetRef: viaRef };
	}

	// NO CARD PICTURE WITHOUT A FEATURED IMAGE, unless this site's own listing was SEEN drawing one from the content.
	//
	// The walk was the default once. Measured on three real sources the answers differ — one draws nothing for such a
	// card, one draws a content picture for every card it shows, one never displays the case — so the walk is a
	// per-site choice that only a positive observation of the source turns on.
	// THE DEFAULT: a featured image or nothing. `options.pick` and `post.content` are simply not consulted, which is
	// the rule itself — no declaration is needed to say so.
	if (!options.contentFirst) return null;
	const pick = options.pick ?? pictureInNode;
	const blocks: unknown[] = Array.isArray(post.content) ? post.content : [];
	const queue: unknown[] = [...blocks];
	while (queue.length > 0) {
		const node = asRecord(queue.shift());
		if (!node) continue;
		const found = pick(node);
		if (found) return found;
		// DOCUMENT ORDER means a container's own children come before the next sibling block, so they go to the
		// FRONT of the queue.
		const children: unknown[] = Array.isArray(node.content) ? node.content : [];
		queue.unshift(...children);
	}
	return null;
}
