---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes a WordPress import that drew the text of a `<style>`, a `<script>` or a `<noscript>` in a post's content as a paragraph. A page builder's text widget keeps its own stylesheet in the post, and a pasted form embed keeps its script, and the imported page showed that CSS or code as text, run into the words around it. The converter now reads no text from these elements, as the browser draws none of it, in classic content, in the block editor's paragraphs, headings and lists, and in an image's caption. A custom HTML block is still kept as it was written.
