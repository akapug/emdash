---
"emdash": minor
"@emdash-cms/gutenberg-to-portable-text": minor
---

Adds `config.mappedFields` to the WordPress WXR import API so integrations can carry collection fields alongside each entry's original content write. Key the map by WordPress post ID and prepare the target fields first. Standard content fields and reserved names cannot be overridden; unknown fields and malformed event dates, booleans, or occurrence arrays produce import errors. Imports that omit the option keep their existing behavior, and `skipExisting` does not update previously imported entries.

Adds `getCollectionByUrlPattern()` for templates that need to discover an import-selected collection by its route. It returns the matching routable collection even when empty, returns `null` when none matches, and rejects ambiguous routing metadata.

Carries saved MEC event views through `config.embeds` in the original WXR content write. A per-post dictionary keyed by source calendar ID supports different views and repeated occurrences without treating a Portable Text block key as source identity. Existing single-embed callers remain supported. Unresolved views render an unavailable notice rather than an unfiltered event list.

Adds the optional `shortcode` conversion callback for replacing raw shortcode tokens in text positions before HTML entity decoding. Returning `undefined` keeps the existing conversion. Integrations can carry their own blocks without activating escaped examples, encoded bracket literals, or tokens in HTML attributes, comments, scripts, or styles.
