---
"@opengeni/react-native": minor
"@opengeni/react": patch
---

Android 14 and later: agents' calls can ask for the full-screen notification permission they need to ring over the lock screen. Play pre-grants `USE_FULL_SCREEN_INTENT` only to calling and alarm apps, so in other apps a ring was only a heads-up notification and nothing told the person why. The Android call module now reports `fullScreenRing` in its capabilities and can open the app's full-screen notification setting (falling back to its notification settings). The call adapter exposes this as `incoming.canRingFullScreen()` and `incoming.openFullScreenRingSettings()`, absent on iOS and older builds, where rings always show full screen. The new `useFullScreenRings(callAdapter)` hook keeps the answer current as the app returns to the foreground and has `ask()`, which explains the setting in an alert and offers to open it, for hosts to call when the person turns agent calls on. `@opengeni/react` adds the default English text for that prompt.
