---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes a WordPress image drawn at its file's size after an import where WordPress drew it smaller through its inline style. The block editor writes an inline image's size as `style="width: 150px;"`, and since WordPress 6.3 a resized image's as `style="width:320px;height:auto"`, with no `width` attribute. An inline style's width in pixels is now the image block's `displayWidth`, ahead of a `width` attribute as in the browser, and its height is then only the style's own, so the image keeps its proportions.
