---
"@opengeni/react": patch
---

`FormDialog` takes `aboveOtherDialogs`, which shows the dialog above every other open dialog, including the chat's connect dialog. The console's admin passkey step-up prompt uses it, so the prompt no longer opens behind the Connect dialog where its button could not be clicked.
