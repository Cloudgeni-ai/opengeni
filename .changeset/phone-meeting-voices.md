---
"@opengeni/react-native": minor
"@opengeni/react": patch
---

The phone meeting screen can now teach Opengeni your voice, as the web page does. Naming a speaker offers "It's me", and naming yourself asks once whether to remember your voice so later meetings suggest your name. A name suggested from a voice shows as Suggested and is confirmed or turned down from its speaker (with Undo), and a named person's voice is remembered or forgotten from their speaker. Someone outside the workspace is remembered only after confirming they agreed. A new name typed on the phone now joins the people directory, as on the web, so their voice can be remembered too. `useMeetingView` gains `viewer` and `voiceRecognition` options for this, and `recordings` to use a recordings client of the host's own.
