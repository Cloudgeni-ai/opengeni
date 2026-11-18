---
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Connecting an integration from the desktop app no longer depends on the browser handing the person back. The Connections page watches for the new connection and finishes as soon as it appears, and the browser page now just says the connection is done and the tab can be closed. When the browser that finishes the consent is not signed in to Opengeni, it asks for one sign-in and then completes the same connection (new `/connect-continue` page and `oauthSignInToFinishPath`/`oauthSignInToFinishTarget` helpers), instead of failing with a browser mismatch. A browser signed in as someone else is still refused, with clearer copy.
