---
"emdash": minor
---

Adds per-post SEO to the WordPress WXR import. Each post's search title, meta description, noindex setting, canonical URL and social image from Yoast SEO, Rank Math or All in One SEO now lands in the entry's SEO fields, where templates read them through `getSeoMeta()` and `<EmDashHead>`. Before, a WXR import kept only the title, content, excerpt and featured image, and every hand-written SEO setting was lost.

A value is carried only when EmDash renders it the way WordPress did, and the import result's new `seo` field counts what was carried and what was left out, by reason:

- Template variables such as `%%title%%`, `%sitename%` and `#post_title` resolve from the export. A title that uses a variable the export has no value for (`%%currentyear%%`, a custom field) is left out rather than stored with the raw variable. EmDash appends the site name to the title itself, so a trailing separator and site name are removed.
- A canonical URL that points at the post itself is left to EmDash, which uses the entry's new URL. One that points at another imported entry is rewritten to that entry's URL pattern. One that points off the site is left out.
- A social image is carried only when it is one of the export's own attachments. The `rewrite-urls` step now points it at the imported media, and reports how many it changed as `seoImagesRewritten`.
- Noindex is carried. EmDash has one robots setting, which sends `noindex, nofollow`, so a nofollow without noindex is left out.

Entries skipped with `skipExisting` get the SEO they are missing when they have no SEO row yet, so re-running an import after upgrading fills it in. An SEO row an editor already has is never changed. Posts in a collection without SEO support are imported as before and counted. Set `importSeo: false` in the execute config to import without SEO.
