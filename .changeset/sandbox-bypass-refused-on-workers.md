---
"emdash": patch
---

`sandbox: false` is refused on Cloudflare Workers whatever else the site configures. Before, the refusal applied only when the build had a sandboxed plugin entry: a site with none still loaded its marketplace plugins in-process, unisolated, and marketplace install and update skipped the sandbox runner check. Now `EmDashRuntime.create()` refuses first, before the database or any plugin bundle is read; `handleMarketplaceInstall()` and `handleMarketplaceUpdate()` answer `SANDBOX_BYPASS_REFUSED` (503) before any marketplace request; and the runtime's marketplace sync refuses too. A `sandboxBypassed` that is not a boolean is refused on every platform.
