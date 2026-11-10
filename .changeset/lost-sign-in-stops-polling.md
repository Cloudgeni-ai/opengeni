---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": minor
"@opengeni/desktop": patch
---

A page whose sign-in is gone now stops instead of polling on. A request refused because its sign-in expired, was revoked or its cookie lapsed answers HTTP 401 `unauthenticated` with `details.code` `session_missing` (no sign-in sent) or `session_expired` (a sign-in cookie or app credential that no longer signs anyone in); another credential that is not accepted, such as an API key, is `credential_invalid`. Route-rejection metrics and logs carry the same reason instead of `unclassified`. The web app hears the first such refusal, confirms with the session read, and leaves the signed-in app at once, so its polling and streams stop and the sign-in page shows; inside the desktop app the window's sign-in is renewed and the page reloads.

The desktop app also stops its window being signed out while the app stays signed in. Its window shares the device's session, which is renewed at most once a day by whichever request comes first. When that was one of the app's own requests (it polls the inbox, also right after the computer wakes), the renewal never reached the window's cookie, so the cookie lapsed a week after it was last set. The app now sends its own requests with the window's cookies, and a request that renews the session returns the renewed window cookie with it.

`@opengeni/contracts` adds `AUTHENTICATION_REQUIRED_REASONS`, `AuthenticationRequiredReason` and `isSignInLostRejection`. `@opengeni/core` adds `AuthenticationRequiredRefusal`. The app state's host can pass `subscribeSignInLost`.
