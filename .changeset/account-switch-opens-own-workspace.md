---
"@opengeni/react": patch
---

When another account signs in on the same browser, an open tab notices (on a refused request or when the tab comes back to the front), drops everything it held for the previous person and opens the new person's own workspace, with one short notice. A link to a workspace the person can't open also says why it opened theirs instead. `AppStateHost.subscribeSignInLost` listeners now receive a reason: `"signed_out"` for a lapsed sign-in (401) or `"forbidden"` for a 403.
