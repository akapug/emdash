---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes the text of a WordPress quote lost on import. Since WordPress 6.2 the block editor saves a quote's paragraphs as inner blocks, and the converter read only the quote's own markup, which then holds the `<blockquote>` alone: every such quote became one empty blockquote. Its inner blocks are now converted, their paragraphs as blockquote text. A quote's citation is now read from the `<cite>` WordPress saves and draws, for both formats; before, only a `citation` block attribute was read, which WordPress does not save.
