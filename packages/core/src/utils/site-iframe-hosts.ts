import { getPageRuntime } from "../page/index.js";
import { getSiteSettings } from "../settings/index.js";

const IFRAME_OPEN = /<iframe/i;

/**
 * The site's own iframe hosts (its `iframeHosts` setting) for HTML about to be
 * sanitized: read only when the HTML has an iframe, and only on a page
 * EmDash's middleware set up (the same check EmDashHead makes before it reads
 * settings). `getSiteSettings()` is request- and isolate-cached, so a page
 * whose layout already read settings pays nothing more.
 */
export async function siteIframeHosts(
	html: string,
	locals: Record<string, unknown>,
): Promise<readonly string[] | undefined> {
	if (!IFRAME_OPEN.test(html) || !getPageRuntime(locals)) return undefined;
	return (await getSiteSettings()).iframeHosts;
}
