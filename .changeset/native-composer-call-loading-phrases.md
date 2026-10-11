---
"@opengeni/react-native": minor
---

The native composer can start a voice call: with a `call` prop, an empty, idle composer's trailing action becomes a call button (audio lines; call-green when that conversation is already on a call), so a new conversation can begin as a call. `NativeSessionScreen` passes it through its composer slots. Hosts can also replace the rotating loading copy beside the orb with `loadingPhrases` in the native timeline messages, matching the web timeline's loading `phrases` option. The call button's labels are the new `startCall` and `returnToCall` messages.
