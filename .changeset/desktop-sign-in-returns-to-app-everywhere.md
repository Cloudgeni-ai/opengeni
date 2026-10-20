---
"@opengeni/contracts": patch
---

Reconnecting an account, adding another account to a connector, connecting Fiken, and the older social sign-in now also bring you back to the desktop app when you start them there. Like Connect, these sign-ins finish in your browser, which now lands on the "Back to Opengeni" page and reopens the app on the page you started from, with the outcome. Their start requests send the browser to `/desktop-return` only when the console marks them as coming from the desktop app (`x-opengeni-desktop-app`), and the hand-back page now also accepts a console path as its destination.
