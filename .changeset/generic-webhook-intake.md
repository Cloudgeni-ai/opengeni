---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/runtime": patch
"@opengeni/config": patch
---

One mechanism reads every app's webhooks. Linear and Sentry are now presets of the custom webhook, like Tailscale, and their own adapters are gone: `WEBHOOK_FORMAT_PRESETS` has `linear`, `sentry` and `tailscale`, and sources stored with the `linear` or `sentry` adapter read as `custom` with that preset (`currentWebhookAdapter`, `webhookPresetOf`). Creating one with the older adapter still works and stores it as `custom`. A format can now say more:

- `signedContent` on `hmac_sha256` for apps that sign more than the body, such as `v0:{header:X-Request-Timestamp}:{body}`.
- An `ed25519` scheme, whose secret is the app's public key.
- A `url_token` scheme for apps that can't sign: the secret is part of the address, at least 24 URL-safe characters.
- `freshness`, which refuses deliveries whose send time is too old.
- A `type` joined from `parts`, lists of fallback paths for the text fields, and `actorKind` to tell people from bots.

Agents with `scheduled_tasks:manage` can add webhook sources themselves. `event_sources_create_webhook` takes a preset or a format and a signing secret, which can be a secret reference, and returns the address to give the app. `event_sources_update` and `event_sources_delete` change and remove sources. For a webhook source, `event_sources_list` with its `sourceId` now shows its format and last five deliveries. The event-triggers Skill explains how to write a format from an app's webhook docs.
