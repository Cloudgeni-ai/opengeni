---
"@opengeni/api-router": minor
"@opengeni/sdk": minor
---

The Excel add-in on Mac and Windows now signs in through the person's own browser, where their saved sign-ins, passwords and passkeys work, instead of Office's embedded window. The pane shows "Continue in your browser" with a short code; the person types it on the browser page and chooses Allow. The new `/v1/native-app/relays` routes carry the sign-in back to the pane: relays last five minutes, are single-use and rate-limited, release the code only to the pane's PKCE verifier, and are approved only with the pane's code. The SDK adds `createNativeAppRelay`, `approveNativeAppRelay` and `pollNativeAppRelay`. Excel on the web keeps its sign-in window. The Mac install steps on `/excel` now say that the `wef` folder usually has to be created.
