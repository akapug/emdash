---
"emdash": patch
---

Fixes the WordPress media URL rewrite matching a URL map key that carries a query string by its base URL. A key such as an attachment's `?attachment_id=7` shortlink stood for the home page too, so every link to the home page was rewritten to that file. Such a key now matches that URL only, and inside a text field only where the URL ends with it.
