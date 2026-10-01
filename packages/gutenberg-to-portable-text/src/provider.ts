/**
 * Embed provider detection, shared by the embed transformers, autoembed and classic iframes
 */

/** The providers EmDash embeds, by the domain of their URLs, in the order they are tried */
const PROVIDERS: ReadonlyArray<readonly [domain: string, provider: string]> = [
	["youtube.com", "youtube"],
	["youtu.be", "youtube"],
	["vimeo.com", "vimeo"],
	["twitter.com", "twitter"],
	["x.com", "twitter"],
	["instagram.com", "instagram"],
	["facebook.com", "facebook"],
	["tiktok.com", "tiktok"],
	["spotify.com", "spotify"],
	["soundcloud.com", "soundcloud"],
	["codepen.io", "codepen"],
	["gist.github.com", "gist"],
];
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;
const LEADING_SLASHES_PATTERN = /^\/\//u;

/**
 * Detect embed provider from URL, by its host: a URL that only contains a
 * provider's domain (dropbox.com and wix.com hold "x.com") is not that
 * provider. A URL written without a scheme ("youtube.com/watch?v=…", or
 * "//www.youtube.com/embed/…") is read as https.
 */
export function detectProvider(url: string): string | undefined {
	if (!url) return undefined;
	const trimmed = url.trim();
	const absolute = SCHEME_PATTERN.test(trimmed)
		? trimmed
		: `https://${trimmed.replace(LEADING_SLASHES_PATTERN, "")}`;
	let host: string;
	try {
		host = new URL(absolute).hostname;
	} catch {
		return undefined;
	}
	return providerOfHost(host);
}

/**
 * The provider whose domain `host` is, or is under. A host that only contains
 * a provider's domain ("api.mapbox.com" holds "x.com") is not that provider.
 */
export function providerOfHost(host: string): string | undefined {
	const h = host.toLowerCase();
	return PROVIDERS.find(([domain]) => h === domain || h.endsWith(`.${domain}`))?.[1];
}
