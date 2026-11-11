---
"@opengeni/react": patch
---

A new chat whose creation is refused now says why. When `createSession` rejects with a definite refusal (an `OpenGeniApiError` with a 4xx status and `outcomeUnknown: false`), the stock new chat shows the refusal's own reason, such as a speed or model that isn't available, instead of the generic "The request could not be accepted" copy. Typed refusals keep their worded copy, and a host endpoint's `{ error: "…", code, details }` body is read as well as Opengeni's own `{ code, message }`. The host's `formatError` receives this reason as its default message, so a host formatter that returns `undefined` for errors it has no copy for shows it too. The draft stays and Send stays available, and changing the model, speed or effort clears the stale reason. Failures whose outcome is unknown (network loss, 5xx, `outcomeUnknown: true`) keep the exact-retry state unchanged.
