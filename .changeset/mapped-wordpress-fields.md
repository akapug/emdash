---
"emdash": minor
---

Adds `config.mappedFields` to the WordPress WXR import API so integrations can carry collection fields alongside each entry's original content write. Key the map by WordPress post ID and prepare the target fields first. Standard content fields and reserved names cannot be overridden; unknown fields and malformed event dates, booleans, or occurrence arrays produce import errors. Imports that omit the option keep their existing behavior, and `skipExisting` does not update previously imported entries.

Adds `getCollectionByUrlPattern()` for templates that need to discover an import-selected collection by its route. It returns the matching routable collection even when empty, returns `null` when none matches, and rejects ambiguous routing metadata.
