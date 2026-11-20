import type { APIRoute } from "astro";

/**
 * An old site's feed address at a file name (Jekyll's /feed.xml and
 * /atom.xml, Hugo's /index.xml), answered with a permanent redirect to this
 * site's own feed, so a subscriber's reader follows it here. EmDash's
 * redirect middleware never looks up a path with a file extension, so no
 * redirect row can do this. Embark's redirects fixup knows these routes (its
 * convention role `feedAlias`) and writes no rule for them.
 */
export const feedAlias: APIRoute = ({ redirect }) => redirect("/rss.xml", 301);
