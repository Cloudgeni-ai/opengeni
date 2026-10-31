---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/react": minor
---

Feedback reports carry what is needed to debug them, not just a screenshot. A report's `context` can now name the chat in view (`sessionId`) and carry the app's latest API requests (`recentRequests`: method, path without its query, status, duration and the server's correlation id, which finds the request's logs), errors nobody caught and files that failed to load (`recentExceptions`, with stacks), and the steps before it (`breadcrumbs`: screens opened, the app hidden or shown, the network lost or back). The web and desktop console and the phone app record these in memory and send them only with a report; the forms say what is sent. The server also stores, with each report and never shown to clients, its own version and deployment revision and, when the author can read the chat in view, that chat's status, last event sequence and latest turn (status, model, reasoning effort and times) in the new `feedback_submissions.diagnostics` column. `OPENGENI_CORRELATION_HEADER` is exported from `@opengeni/sdk/browser`. The phone app resends a report without the new fields when a server older than the app refuses them.
