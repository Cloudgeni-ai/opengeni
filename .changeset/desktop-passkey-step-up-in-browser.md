---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/desktop": patch
"@opengeni/sdk": patch
---

Admin changes that need a passkey now work from the desktop app. The app can't show passkey prompts (Electron has no passkey UI on macOS or Linux, so the prompt never opened and the dialog spun forever), so confirming now opens the person's own browser on the same server. There they use their passkey, with their password manager or device, and the browser then shows a one-time code to type into the app. Only the app session that started the confirmation can use that code, a few wrong codes void it, and it expires after ten minutes, so a forwarded link can't confirm anyone else's session. In the app, Add passkey opens the browser's security page, and passkey sign-in is hidden there. Signing a signed-out account in again from the app's sign-in page now uses that account's own server instead of the app's default one. Passkey prompts and step-up requests that never answer now end with a clear message instead of waiting forever.
