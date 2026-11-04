---
"emdash": minor
---

The plugin id `"system"` is reserved: `definePlugin` and the plugin manifest schema refuse it, because a plugin's email source is its id and `"system"` is the source of EmDash's own auth mail, which no `email:beforeSend` or `email:afterSend` hook sees. `EmailPipeline.sendAsPlugin()` is the send a plugin's `ctx.email.send()` goes through, natively and through the sandbox bridges; it refuses the `"system"` source with `ReservedEmailSourceError`.
