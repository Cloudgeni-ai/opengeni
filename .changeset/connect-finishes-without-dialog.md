---
"@opengeni/api-router": patch
"@opengeni/react": patch
---

Connecting a built-in integration such as SharePoint, Outlook or OneDrive now finishes as soon as the person signs in: the provider's callback saves the account and adds every reviewed tool in one step, so nobody waits on "Finishing setup…" and closing the dialog, reloading or quitting the desktop app during the hand-back can no longer leave the account connected without tools. The Connect dialog closes itself and the Capabilities page says "SharePoint connected". The callback finishes only what the person who started the setup could have installed themselves, with the same permission and member policy checks; otherwise, or if the reviewed tools cannot be read in time, it saves the account as before and the app finishes. Closing the Connect dialog after signing in now lets the remaining setup carry on in the background (`continueConnectSetup`).
