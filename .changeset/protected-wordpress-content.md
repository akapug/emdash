---
"emdash": minor
---

Adds opt-in password-protected WordPress pages and posts to the blog and Cloudflare blog templates. A matching password renders the content for that request with private, no-store caching. Ordinary content reads, search, feeds and preview snapshots contain redacted fields rather than the protected body, excerpt or SEO text.

Custom importers must check that the authenticated WordPress analyze response advertises `protectedContentCapability: "emdash.protected-content.v1"` before submitting the matching `protectedContent` option to execute. Use `passwordSource: "raw-wxr"` only for an actual raw WordPress export. Connector imports can supply versioned verifiers or explicit redacted credentials through `protections`. Missing opt-in and unrecoverable passwords retain the draft fallback; file-only CLI exports also remain drafts.

Custom page routes must call `resolveProtectedEntry` before building layouts or SEO metadata. Apply the database migration before importing protected content, and retain a capable runtime while protected content exists. Protected payloads and verifiers are excluded from site transfers.
