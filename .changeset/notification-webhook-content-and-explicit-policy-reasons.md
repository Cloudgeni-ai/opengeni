---
"@opengeni/api-router": patch
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
---

Notification webhooks now carry the notification itself. `session.notification.posted` deliveries include its bounded `key`, `title`, `subtitle`, `body`, `facts`, `link`, `urgency`, `replaced`, and member `recipientSubjectId`/`sender`, and `session.notification.withdrawn` includes its `key`, on both workspace and organization lanes. Other event fields are never copied. When Opengeni notified nobody because the session works for no person (an API key or service started it), the event and its webhook carry `undeliveredReason: "no_human_recipient"`, so an integration can deliver it itself.

Deployment policy no longer narrows an explicit request silently. A resolved agent configuration now reports `unavailableReasons` next to `unavailable`, naming why each capability is off. Updating a session's tool policy with first-party tools the deployment disables now fails with 422, naming every such tool and the allowed set; tools echoed from the session's stored selection or defaults are still filtered as before, so a later policy change never blocks an unrelated edit.
