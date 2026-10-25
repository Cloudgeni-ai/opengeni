---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/desktop": minor
---

Send feedback on web and in the desktop app attaches screenshots and context, like the phone app. The form offers **Take screenshot** (the desktop app takes a still of its own page without asking, and attaches one as the form opens; browsers use tab capture), **Add image** and paste, up to three images, each removable. `FeedbackDialog` takes `screenshots` and `reportContext`; `webFeedbackContext` (in `@opengeni/react/app/lib/feedback-capture`) reports web or desktop, versions, the page, browser, language, time zone, connection and the last error toasts, which `recordErrorToasts` (in `@opengeni/react/app/lib/recent-errors`) remembers. The desktop bridge gains the `captureWindow` capability and `appVersion`.
