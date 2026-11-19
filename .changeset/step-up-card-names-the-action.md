---
"@opengeni/react": patch
"@opengeni/connect": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

Giving a connected account more access is now one clear step. When an action set to Ask first needs access its account doesn't have yet (for example marking Gmail messages as read on a read-only connection), its approval card says so in one line ("Google will ask you to allow Opengeni to organize your Gmail (one time).") and Approve opens Google's consent first, then approves that one call. Later calls still ask according to your approval settings. The action's review carries the missing access as `accessNeeded`.

When no approval is involved, the access card names the action ("Allow Opengeni to organize your Gmail"), says what it includes and that your approval settings still decide what runs without asking. It shows the service's logo, and its button goes straight to the provider's consent page ("Allow in Google"), shows that it is waiting, and says "Allowed" when done, with no setup dialog in between. Sign-in popups for these cards close themselves when finished instead of loading the app inside the popup. When an agent hits the same missing access more than once, the chat shows one card.

An email to be sent is still shown in full on that card. If the provider's window is closed, pressing Decline or Approve again stops waiting for it.

For hosts: `ApprovalSurface` takes `onAllowAccess(access, approval, signal)`, called in the Approve click for an action with `review.accessNeeded`; the signal aborts when the person presses again. Without it, the card says the access is still missing (`approvalSurface.accessStillMissing`). `MessageTimeline`'s `onReconnect` may now return `{ outcome: "done" }` and receives an abort `signal`; the types are exported as `AuthNeededRecoveryHandler`, `AuthNeededRecoveryOptions`, `AuthNeededRecoveryResult` and `ToolReviewAccessNeeded`. The unused message keys `messageTimeline.accessDraftAndSendEmail`, `accessOrganizeMailbox`, `allowAccess`, `giveProviderMoreAccess` and `itNeedsPermissionTo` were removed; overrides of them no longer apply. `@opengeni/connect/browser-navigation` exports the popup reservation on its own.

A chat whose agent waits on a connection card (connect, reconnect or more access) now shows as needing you, like an approval: in Needs you, with the orange dot, and on the parent chat's "needs you" bar for a sub-agent. It clears when the card is done or you send a new message. Sessions and list entries carry `awaitingConnectionSince`.
