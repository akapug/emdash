---
"emdash": patch
---

POST `/_emdash/api/auth/invite` says whether it emailed the invite: `emailed: true` only when the email pipeline reports the send "sent". Otherwise it answers `emailed: false` with the invite link to share, as it does when no provider is configured.
