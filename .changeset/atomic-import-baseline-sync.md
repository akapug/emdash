---
"emdash": minor
---

Adds versioned import synchronization at `/_emdash/api/import/wordpress/sync` for integrations that update published WordPress pages and posts. The endpoint creates an entry with a source mapping and original revision, then accepts updates only while that entry remains importer-owned. Same-value saves and associated SEO, byline, or taxonomy edits end automatic ownership. The original import snapshot stays available in revision history.

Check the endpoint's GET capability before submitting mapped EmDash field data. Updates preserve omitted fields and require the entry ID and version from the previous applied receipt; retries reuse the exact request and operation ID. Every request also requires an active tenant-local import grant bound to the source site, serving binding and authenticated actor. Revoking the grant prevents an in-flight request from committing after the revocation. Previously applied receipts remain replayable.

SQLite and Cloudflare D1 require the import provenance and grant migrations and edit-tracking triggers. Import permission and an admin-scoped bearer token or admin session are required; authentication alone does not create an import grant.

Existing WXR and exporter imports remain unchanged and cannot be adopted into synchronization by matching slug or content. Integrations must explicitly use this endpoint for their initial create. See the content import guide for the request and receipt contract.
