---
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Stay calm while Opengeni is updating. The SDK now decodes the parked maintenance answer (`{"error":"maintenance"}`) into an `OpenGeniApiError` with `code: "maintenance"`, `retryable: true` and `outcomeUnknown: false`, without a support reference. `isMaintenanceError` and `OPENGENI_MAINTENANCE_ERROR_CODE` are exported, and `isTransientRequestError` treats the marker as transient.

In the console and embedded chat, an update or brief outage no longer shows red errors, References, a "Queue needs attention" chip or error toasts. The composer shows one line, "Opengeni is updating. We'll reconnect automatically.", keeps a message sent meanwhile in place with the same idempotency key and delivers it once the API answers, and clears on its own. Reads keep retrying for as long as the maintenance marker lasts. Other transient failures stay calm for two minutes; after that, and for any definitive error, the existing error copy appears. At startup, the web, desktop and embedded apps show "Updating" or "Reconnecting" and continue by themselves when the API is back, with Try again as a secondary action.
