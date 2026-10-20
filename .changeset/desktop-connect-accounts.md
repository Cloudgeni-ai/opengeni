---
"@opengeni/desktop": patch
---

Connecting an account from the desktop app works again. Connect, GitHub and model sign-in buttons that open a sign-in window failed with "Allow popups to connect your account", because the app refused every new window. The app now accepts the blank window such a flow reserves, opens the provider's sign-in page in your browser, and the app picks up the finished connection by itself. Pages from the account's own server that a flow opens show as an app window.
