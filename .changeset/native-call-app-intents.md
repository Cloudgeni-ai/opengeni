---
"@opengeni/react-native": minor
---

Add an Expo config plugin for system voice calls: it sets the Info.plist keys CallKit needs (`audio` and `voip` background modes, `INStartCallIntent`, microphone purpose, optional Siri app-name synonyms) and generates an App Intent with App Shortcut phrases, so Siri, Spotlight, the Shortcuts app and the Action button can start a call with the agent. `OpenGeniCallLauncher.requestStart()` is the public native entry point.
