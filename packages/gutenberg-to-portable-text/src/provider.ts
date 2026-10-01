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

/**
 * Detect embed provider from URL
 */
export function detectProvider(url: string): string | undefined {
	if (!url) return undefined;

	const urlLower = url.toLowerCase();
	return PROVIDERS.find(([domain]) => urlLower.includes(domain))?.[1];
}

/**
 * The provider whose domain `host` is, or is under. Unlike detectProvider, a
 * host that only contains a provider's domain ("api.mapbox.com" holds "x.com")
 * is not that provider.
 */
export function providerOfHost(host: string): string | undefined {
	const h = host.toLowerCase();
	return PROVIDERS.find(([domain]) => h === domain || h.endsWith(`.${domain}`))?.[1];
}
