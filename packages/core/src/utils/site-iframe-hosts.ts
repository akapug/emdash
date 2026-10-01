import { getPageRuntime } from "../page/index.js";
import { getSiteSettings } from "../settings/index.js";
import { canonicalIframeHosts, withoutSiteHosts } from "./iframe-hosts.js";

const IFRAME_OPEN = /<iframe/i;

/**
 * The site's own iframe hosts (its `iframeHosts` setting) for HTML about to be
 * sanitized: read only when the HTML has an iframe, and only on a page
 * EmDash's middleware set up (the same check EmDashHead makes before it reads
 * settings). `getSiteSettings()` is request- and isolate-cached, so a page
 * whose layout already read settings pays nothing more.
 *
 * The stored value is read through `canonicalIframeHosts` (a raw options row
 * never met the settings schema). The page's own host and the site's
 * configured URL host, and every subdomain of either, are then dropped: whatever the stored setting says, an
 * iframe of the site itself is never allowed by it.
 */
export async function siteIframeHosts(
	html: string,
	locals: Record<string, unknown>,
	pageUrl: URL,
): Promise<readonly string[] | undefined> {
	if (!IFRAME_OPEN.test(html) || !getPageRuntime(locals)) return undefined;
	const { iframeHosts, url } = await getSiteSettings();
	const configured =
		typeof url === "string" && URL.canParse(url) ? new URL(url).hostname : undefined;
	// Canonical first, so the exclusion and the sanitizer judge the same strings.
	return withoutSiteHosts(canonicalIframeHosts(iframeHosts), [pageUrl.hostname, configured]);
}
