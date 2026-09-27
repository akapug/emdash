---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes a WordPress image drawn larger after an import than WordPress drew it. The converter now records an image tag's `width` and `height` (which the classic editor writes on every image, and the block editor on a resized one) as the image block's `displayWidth` and `displayHeight`. The import holds only an upload's original file, and its media rewrite moves a link to a size cut from it (`photo-300x256.png`) onto that original, so without the recorded size the image was drawn at the original's size.
