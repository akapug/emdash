---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes imported WordPress posts showing a bare URL where WordPress showed a video or other embed. A URL alone on its line or in its own paragraph, or in an `[embed]` shortcode, now becomes an embed block when WordPress core would embed it: YouTube, Vimeo, and the other oEmbed providers that core supports, plus audio and video file links. This applies to classic-editor posts, to classic content between blocks, and to paragraph blocks. An `[embed]` URL that WordPress cannot embed becomes a link, as it does in WordPress.
