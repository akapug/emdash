---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes images lost from a WordPress import when they sit inside a heading, a list item or a quote. The classic editor puts an image where the cursor is, often at the start of a heading, and the block editor's inline image sits in a paragraph's, heading's, list item's or quote's text; the converter read those elements' text alone and dropped every image in them. Each image is now an image block of its own, in the order WordPress draws it, with its alignment, its display size and the link around it, and the text around it stays a heading, a list item or a quote.
