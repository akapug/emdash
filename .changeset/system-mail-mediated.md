---
"emdash": minor
---

Adds the `systemMail: { binding, capability }` option. With it, the magic-link, sign-up, invite and admin recovery routes send EmDash's own sign-in mail through the site's mail broker: a separate Worker bound to the site as a service (`@emdash-cms/cloudflare/auth-mail`). Every request carries the site's generation capability (the secret `capability` names, `MAIL_BROKER_CAPABILITY` by default), which the broker checks first; it then authenticates the request, issues the token, renders the message and sends it itself. These routes then never build or send that mail in the site's Worker, so no plugin hook can see it. If the binding or the capability is missing, nothing is sent and the routes never fall back to the site's own email pipeline; an invite still returns its copy link. `GET /_emdash/api/settings/email` reports `systemMail`, including the broker's own status for the site's capability.
