---
"@emdash-cms/cloudflare": minor
---

The Cloudflare Email Sending provider now checks every message before it reaches the binding. A `to` or `cc` that is not one plain address is refused, and a `replyTo` that is not is dropped, so form input cannot add a recipient or start a header. The subject and the sender's name lose their control characters (CR and LF among them). Each sending source (auth mail, the admin's test email, each plugin) has its own budget of recipients per hour and per day (`limits`, default 50 and 200), so one flooded form cannot spend the budget the login email needs. Without `from.name`, the sender's name is the site's title. A new "Reply-To address" setting holds the site's own address for messages that name no reply-to, and a `status` route says the sender, whether the Worker has the binding, and where replies go.
