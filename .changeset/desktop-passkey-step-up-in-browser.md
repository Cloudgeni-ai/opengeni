---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/desktop": patch
"@opengeni/sdk": patch
---

Admin changes that need a passkey now work from the desktop app. The app can't show passkey prompts (Electron has no passkey UI on macOS or Linux, so the prompt never opened and the dialog spun forever), so confirming now opens the person's own browser on the same server. There they use their passkey, with their password manager or device, after checking a six-digit code that the app also shows. The app continues by itself once they have. A confirmation is single-use, expires after ten minutes, and works only for the same account, so step-up still needs the person's own passkey. In the app, Add passkey opens the browser's security page. Signing a signed-out account in again from the app's sign-in page now uses that account's own server instead of the app's default one. In any browser, a passkey prompt that never opens now ends with a clear message instead of waiting forever.
