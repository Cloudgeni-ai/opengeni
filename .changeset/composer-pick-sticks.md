---
"@opengeni/react": patch
---

A model, reasoning effort or speed picked in a chat's composer now sticks even before anything is typed or sent. Before, a pick on its own was never saved to the chat's draft, so opening another chat or reloading brought back the old setting. The pick is now saved to that chat's draft straight away, on web, the desktop app and mobile.
