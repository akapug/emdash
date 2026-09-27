---
"emdash": minor
"@emdash-cms/plugin-forms": patch
"@emdash-cms/cloudflare": patch
---

One redaction for every logged email error: `redactAddresses`, `describeRedacted` and `scrubAddresses` (exported from `emdash`) replace each address a message names in any letter case (and URL-encoded), then every other address-shaped run, a quoted local part included, with `<an address at DOMAIN>`, over an error's message, stack, own string properties and causes. The email pipeline scrubs a provider's error before it logs and rethrows it, and redacts afterSend errors; the forms plugin's notification, digest and autoresponder failures and the Cloudflare provider's binding errors go through it too.
