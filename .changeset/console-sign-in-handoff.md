---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/db": patch
---

Opengeni Console on its own host now signs in with the person's Opengeni account on the app host: signed in to the app, they reach Console without a second sign-in; signed out, the app's sign-in runs first (email, Google, GitHub and passkeys) and brings them back to the Console page and organization they were opening. The app hands Console a single-use code that expires in sixty seconds, is stored only as a hash, and is bound to the person, a verifier in a host-only Console cookie and a configured Console origin; Console redeems it for its own session (`/v1/console-sign-in/start`, `/authorize`, `/callback`) and records each handoff in the audit log as `auth.console_sign_in_handoff`. Console's Sign out waits on a signed-out page with Continue, so it never signs straight back in. Console's own email and Google sign-in stay available as a fallback. No new settings; the handoff is off in the `dual` and `broker` browser session-set modes.
