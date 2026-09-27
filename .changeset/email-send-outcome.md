---
"emdash": minor
---

`EmailPipeline.send()` returns what the send came to: `{ status: "sent" }`, or `{ status: "cancelled", by }` when an `email:beforeSend` plugin stopped it. A cancelled send still returns normally and sends nothing, so the admin's test email (POST `/_emdash/api/settings/email`) now answers 422 `EMAIL_CANCELLED`, naming the plugin, instead of reporting it sent.
