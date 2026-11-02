---
"@opengeni/api-router": patch
"@opengeni/react": patch
"@opengeni/db": patch
"@opengeni/connect": patch
"@opengeni/sdk": patch
---

Connecting a built-in integration such as SharePoint, Outlook or OneDrive now finishes as soon as the person signs in: the provider's callback saves the account and adds every reviewed tool in one step, so nobody waits on "Finishing setup…" and closing the dialog, reloading or quitting the desktop app during the hand-back can no longer leave the account connected without tools. The Connect dialog closes itself and the Capabilities page says "SharePoint connected". The callback reads the reviewed tools before its short commit and finishes only what the person who started the setup could have installed themselves, with the same permission and member policy checks.

If the callback cannot read the reviewed tools in time, the server keeps trying in the background. A setup still left with a saved account and no tools finishes the next time the person opens Capabilities or an in-chat setup card for it is shown, through the new `POST /v1/workspaces/:workspaceId/connect/attempts/finish` (`connectTransport().finishUnfinished`, `finishUnfinishedConnectSetups`); in chat, its tools then join that chat and the agent continues. This covers setups from before this release too, for 7 days after they started and even once their attempt has expired (it then moves from `expired` to `complete`; the transition report carries the previous state). Finishing applies the same rollout, permission and member policy checks as installing by hand, finishes one setup per account at a time, and never finishes a setup that a later setup of the same account replaced, so tools the person removed stay removed. Neither Capabilities nor the chat card waits for it. Closing the Connect dialog after signing in also lets the remaining setup carry on in the background (`continueConnectSetup`); `NativeConnectSetup`'s `onComplete` can therefore fire after `onClose`.
