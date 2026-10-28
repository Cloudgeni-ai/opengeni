---
"@opengeni/desktop": patch
---

Desktop dictation: the first shortcut now hears the app's language even when the app only learns it after sign-in. `createDesktopDictation` reads its settings each time instead of once at startup, and its `language` option can be a function, so until the person saves a choice the first shortcut follows the language the app reports. Before, an app that started before sign-in kept the computer's language, so a Norwegian account on an English Mac dictated in English.
