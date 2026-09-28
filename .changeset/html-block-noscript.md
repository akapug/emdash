---
"emdash": patch
---

Fixes an HTML block that drew what a `<noscript>` holds. The sanitizer removed the element but kept its contents, so a pasted embed's "turn on JavaScript" message showed as text, and an image in it, often a tracking pixel, loaded on every page view. A `<noscript>` is now removed with everything in it, as a `<script>` or a `<style>` already was.
