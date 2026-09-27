---
"emdash": minor
"@emdash-cms/plugin-forms": patch
"@emdash-cms/cloudflare": patch
---

One redaction for every logged email error: `redactAddresses`, `describeRedacted`, `scrubAddresses` and `redactPayload` (exported from `emdash`) replace each address a message names in any letter case (and URL-encoded), then every other address-shaped run, a quoted local part included, with `<an address at DOMAIN>`, over an error's message, stack, own properties (strings, and the plain data a structured error carries, such as a response body) and causes; `redactPayload` does the same for a structured log payload. The email pipeline scrubs a provider's error before it logs and rethrows it, and redacts afterSend errors; the forms plugin's notification, digest and autoresponder failures and the Cloudflare provider's binding errors go through it too.
