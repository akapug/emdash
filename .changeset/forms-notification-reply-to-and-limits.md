---
"@emdash-cms/plugin-forms": minor
---

A form notification's Reply-To is now the visitor, when the form asks for their email address, so the owner answers them with one click. Each form also has mail limits (`notificationLimits`, default 10 submissions an hour and 50 a day): a submission past either is stored as usual and sends no notification or autoresponder. A notification or digest that fails to send is logged with the recipient's domain, never the address.
