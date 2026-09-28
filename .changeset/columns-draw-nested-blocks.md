---
"emdash": patch
---

Fixes images, galleries, embeds, buttons and nested columns inside a `columns` block or a `cover` block rendering as hidden unknown blocks. A column's content and a cover's content are now drawn with the same components as the rest of the page, including the `components` overrides passed to `PortableText`, so a two-column layout imported from WordPress shows the image in its column.
