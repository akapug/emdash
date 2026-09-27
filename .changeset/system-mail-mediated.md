---
"emdash": minor
---

Adds the `systemMail: { binding }` option. With it, the magic-link, sign-up, invite and admin recovery routes send EmDash's own sign-in mail through an auth-mail mediator: a separate Worker bound to the site as a service (`@emdash-cms/cloudflare/auth-mail`). The mediator authenticates the request, issues the token, renders the message and sends it itself. These routes then never build or send that mail in the site's Worker, so no plugin hook can see it. If the binding is missing, nothing is sent and the routes never fall back to the site's own email pipeline; an invite still returns its copy link. `GET /_emdash/api/settings/email` reports `systemMail`, including the mediator's own status.
