---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Apps can receive webhooks and send notifications. A webhook gives another service an address and a secret (bearer or HMAC signature) that writes JSON deliveries into one shared collection of an app, firing the app's normal change events; manage them with `listAppWebhooks`, `createAppWebhook`, `updateAppWebhook` and `deleteAppWebhook` in the SDK and the `app_webhook_save`, `app_webhook_list` and `app_webhook_delete` agent tools. App pages call `site.notify({ title, body, to, path, key })` from `@opengeni/sdk/site` (or `notifyFromApp` from the SDK client) to send an inbox notification that opens the app. See docs/app-webhooks.md.
