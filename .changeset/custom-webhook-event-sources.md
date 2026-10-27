---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
---

Automations can listen to any app's webhooks. A new `custom` webhook adapter reads deliveries as the source's `format` describes: how they are signed (`standard_webhooks`, `hmac_sha256` of the body in a header, `timestamped_hmac_sha256` as Stripe and Tailscale send, or a shared `token` header), whether one delivery holds a list of events, and where each event's type, id, time, summary, subject, link and actor are (JSON paths or headers). The whole event is the event's data, so trigger conditions can filter on any field. The secret is the one the app shows or the one a person set there; the source waits, blocked, until it is pasted. `WEBHOOK_FORMAT_PRESETS` ships Tailscale's format: "Add a source" offers Tailscale by name, and its event-type catalog lists Tailscale's documented types.
