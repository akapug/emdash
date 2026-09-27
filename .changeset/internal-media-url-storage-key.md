---
"emdash": patch
---

Fixes a WordPress import's featured images staying unresolved URLs with no size. The media step maps each attachment to `/_emdash/api/media/file/<storageKey>`, and the `rewrite-urls` step normalizes the post's image from that URL through the local media provider's `get()`, which looked the storage key up as a media id. A storage key is never a media id, so every lookup missed and the post kept `{ provider: "external", src }` with no width, height, alt or media id. The local provider's `get()` now also finds an item by the storage key its file is served under, so the post holds the local media item, and a template that sizes or crops a featured image by its width can draw it. Any other bare internal media URL written to an image field, for example through the content API, resolves the same way. Posts imported before this fix keep the old value until they are imported again.
