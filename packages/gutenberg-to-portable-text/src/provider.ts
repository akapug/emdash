/**
 * Embed provider detection, shared by the embed transformers and autoembed
 */

/**
 * Detect embed provider from URL
 */
export function detectProvider(url: string): string | undefined {
	if (!url) return undefined;

	const urlLower = url.toLowerCase();

	if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
		return "youtube";
	}
	if (urlLower.includes("vimeo.com")) {
		return "vimeo";
	}
	if (urlLower.includes("twitter.com") || urlLower.includes("x.com")) {
		return "twitter";
	}
	if (urlLower.includes("instagram.com")) {
		return "instagram";
	}
	if (urlLower.includes("facebook.com")) {
		return "facebook";
	}
	if (urlLower.includes("tiktok.com")) {
		return "tiktok";
	}
	if (urlLower.includes("spotify.com")) {
		return "spotify";
	}
	if (urlLower.includes("soundcloud.com")) {
		return "soundcloud";
	}
	if (urlLower.includes("codepen.io")) {
		return "codepen";
	}
	if (urlLower.includes("gist.github.com")) {
		return "gist";
	}

	return undefined;
}
