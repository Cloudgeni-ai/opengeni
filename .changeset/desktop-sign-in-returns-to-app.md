---
"@opengeni/contracts": patch
---

A sign-in started in the Opengeni desktop app now brings you back to the app. Connecting Gmail or another account from the desktop app opens the provider in your browser; when the provider is done, the browser lands on a small "Back to Opengeni" page that reopens the app, where the connection shows its result. The console marks its requests inside the desktop app (`x-opengeni-desktop-app`), and Connect sends that browser to `/desktop-return` only when the return page is the requesting console's own page. Return pages of embedding products are unchanged.
