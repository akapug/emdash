---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a homepage setting, so a site can open on a chosen page instead of its latest posts. In **Settings > General**, set **Homepage displays** to **A page** and pick the entry. API and MCP clients send `homepage: { collection, id }` in the site settings, or `homepage: null` to return to the latest posts. A request that names an entry that does not exist is refused with `VALIDATION_ERROR`. Settings responses also report `homepage.entry`, the translation the site shows (`{ id, locale, status }`, or `null` when no translation is left), so a client can tell a draft homepage from a published one.

Templates render the choice with the new `getHomepage()`. It returns the chosen entry in the request's locale, or `entry: null` when no homepage is set or the entry is deleted or unpublished, so the index route can fall back to its usual content:

```astro
---
import { getHomepage } from "emdash";

const { entry: page, cacheHint } = await getHomepage();
if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
---
```

The blog templates use it at `/` and point the chosen page's own URL at `/` as its canonical URL. Sites that do not set a homepage render as before. See [Render the chosen homepage](https://docs.emdashcms.com/guides/site-settings/#render-the-chosen-homepage).

Site transfer carries the homepage setting. A site on an earlier version refuses a package that has it with a `record_invalid` blocker, so update the target site before you import the package.
