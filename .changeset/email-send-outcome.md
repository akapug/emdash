---
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

`EmailPipeline.send()` returns what the send came to: `{ status: "sent" }`, or `{ status: "cancelled", by }` when an `email:beforeSend` plugin stopped it. A plugin's `ctx.email.send()` resolves to the same answer, natively and through the Cloudflare and workerd sandbox bridges. A cancelled send still returns normally and sends nothing, so the admin's test email (POST `/_emdash/api/settings/email`) now answers 422 `EMAIL_CANCELLED`, naming the plugin, instead of reporting it sent.
