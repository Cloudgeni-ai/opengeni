---
"@opengeni/browserd": patch
---

A managed browser no longer signs in to an account by itself through a saved passkey. Each tab's virtual authenticator holds the passkeys its user may use and answers requests without a person present, so a sign-in page that asked for passkey autofill on load (a conditional `navigator.credentials.get`, which many identity providers send on their account-chooser and identifier pages) was answered at once with a saved passkey. A fresh browser, even one with a new or empty identity, was then signed in to that account before anyone chose it, and "use another account" or signing out signed it straight back in.

Tabs and their frames, including cross-site frames that share the tab's authenticator, are now told that passkey autofill is unavailable, and an autofill request stays pending until the page cancels it, as it would in a browser where nobody picks a passkey. A passkey is still used when the page asks for one in the open, for example after a "Sign in with a passkey" click. A tab that cannot take this is given no authenticator.
