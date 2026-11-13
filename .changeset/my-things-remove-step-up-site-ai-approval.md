---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

- My things: each of your own logins has Remove, which removes it from every workspace after you confirm.
- Connect cards: when turning an integration on waits for an admin to confirm with a passkey, the card offers that as its action. Hosts set it with `onAdminStepUp` on `SessionApp` (or `adminStepUp` on the app host); by default the Opengeni app's page for it opens, then Try again.
- `site.ai.run` and `site.ai.result` take `waitForApproval: true` to wait through approvals and input requests and resolve with the final result once the person answers in Opengeni; `onWait` reports the wait. Without it a wait still resolves as `pending`.
