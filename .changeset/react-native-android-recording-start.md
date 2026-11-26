---
"@opengeni/react-native": patch
---

Android recording and dictation start again in release builds with R8 optimization. The recorder's start options were an Expo `Record`, which Expo converts by Kotlin reflection, and that conversion fails in optimized builds, so every start was rejected before the microphone opened. The options are now read from the plain object.
