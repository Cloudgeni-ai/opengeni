---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Shared chat fixes for embedding products:

- Counted labels no longer crash on Hermes (React Native), which has no `Intl.PluralRules`. Without it, 1 uses the `_one` form and every other count `_other`, so no polyfill is needed.
- The voice button no longer names the voice model: it reads "Start voice", "Try voice again" and "Talk live with the agent." The React Native call screen no longer shows the model as its subtitle. Hosts can name the action after their assistant through `messages`, for example `"realtime.realtimeControl.startVoice": "Talk to Ava"`. The keys `realtime.realtimeControl.startVoiceWithLabel`, `tryVoiceAgainWithLabel` and `talkLiveWithModellabel` are replaced by `startVoice`, `tryVoiceAgain` and `talkLiveWithTheAgent`.
- A turn that stops because automatic capacity recovery ran out now shows a translatable explanation (`lib.format.capacityRecoveryExhausted`) instead of the server's English text. The stored event is unchanged.
