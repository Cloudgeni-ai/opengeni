---
"@opengeni/react-native": minor
"@opengeni/react": patch
---

Phone apps can walk people through starting a voice call with a spoken phrase of their own, such as "Hey Opengeni". iPhone (iOS 18 and later) runs a Siri request when the person says a phrase they taught it under Settings › Accessibility › Vocal Shortcuts; apps cannot create those phrases themselves. The new `WakePhraseGuide` shows the three steps, copies the Siri request that starts the app's call shortcut ("Talk to <name>" by default, so it must match one of the call plugin's phrases), and opens Settings. `wakePhraseSetupAvailable()` says whether the phone supports it. The Opengeni phone app offers it in Settings as Set up "Hey Opengeni". The guide's text uses new `native.realtime.wakePhrase.*` message keys.
