---
"@opengeni/api-router": patch
"@opengeni/react": patch
"@opengeni/db": patch
"@opengeni/connect": patch
"@opengeni/sdk": patch
---

Connecting a built-in integration such as SharePoint, Outlook or OneDrive now finishes as soon as the person signs in: the provider's callback saves the account and adds every reviewed tool in one step, so nobody waits on "Finishing setup…" and closing the dialog, reloading or quitting the desktop app during the hand-back can no longer leave the account connected without tools. The Connect dialog closes itself and the Capabilities page says "SharePoint connected". The callback reads the reviewed tools before its short commit and finishes only what the person who started the setup could have installed themselves, with the same permission and member policy checks.

If the callback cannot read the reviewed tools in time, the server keeps trying in the background. Any setup still left with a saved account and no tools (including ones from before this release, even after their attempt expired) finishes when the person next opens Capabilities, through the new `POST /v1/workspaces/:workspaceId/connect/attempts/finish` (`connectTransport().finishUnfinished`, `finishUnfinishedConnectSetups`). Closing the Connect dialog after signing in also lets the remaining setup carry on in the background (`continueConnectSetup`).
