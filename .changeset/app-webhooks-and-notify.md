---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Apps can receive webhooks. A webhook gives another service an address and a secret (bearer or HMAC signature) that writes JSON deliveries into one shared collection of an app, firing the app's normal change events; manage them with `listAppWebhooks`, `createAppWebhook`, `updateAppWebhook` and `deleteAppWebhook` in the SDK and the `app_webhook_save`, `app_webhook_list` and `app_webhook_delete` agent tools. Deliveries write on the authority of the person who saved the webhook while they still manage the app. `site.notify` in `@opengeni/sdk/site` and `notifyFromApp` in the SDK client are added for inbox notifications from apps but aren't enabled yet: they answer `notify_not_available` until a later release enables delivery. See docs/app-webhooks.md.
