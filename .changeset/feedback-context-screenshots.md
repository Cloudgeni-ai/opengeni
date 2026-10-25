---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

Feedback can now carry where it came from and what the person saw. `createFeedback` accepts an optional `context` (source, how it was opened, app version and build, OS, device model, the screen in view, locale, time zone and up to ten recent errors) and up to three JPEG or PNG `screenshots` of at most 3 MiB each. Screenshots are stored in object storage under create-only, content-addressed keys, so an identical retry stores nothing new, and returned feedback lists each one's index, type, size and SHA-256. The author can read an image with `GET /v1/workspaces/:workspaceId/feedback/:feedbackId/screenshots/:index`. In the phone app, shaking the phone opens Send feedback with a screenshot of the current screen (removable before sending); reports wait on the phone and retry until the server accepts them, and Settings has a Send feedback row and a Shake to send feedback toggle.
