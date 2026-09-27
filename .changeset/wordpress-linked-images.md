---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes linked images that a WordPress import converted without their link. The block editor saves an image block's "Link to" as a link around the image, and the classic editor's captioned image and a `<figure>` hold one too; the image was converted unlinked in each. So was a classic image on a line of its own inside its link, where WordPress writes a line break inside the link. The image block now keeps the link, and a block-editor link set to open in a new tab keeps that as well. A link written with white space around its address (`href=" https://…"`), which WordPress follows, is now kept on text and images alike instead of becoming a link to nowhere, and an image link with an unsafe scheme is dropped, as a text link's already was.
