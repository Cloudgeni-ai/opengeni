---
"@opengeni/react-native": patch
---

Recording on Android 13 and later asks to post notifications right after the microphone is allowed, so the ongoing "Recording audio" notification shows, and the `recording` config plugin declares the permission. The notification and status bar now show a microphone instead of the app icon, which Android draws as a blank disc.
