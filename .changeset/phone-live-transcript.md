---
"@opengeni/react-native": minor
"@opengeni/react": minor
---

Phones show the live transcript too. With `liveTranscript: true`, the native recorder streams the microphone to the workspace's live speech model and fills `snapshot.live`, as the browser recorder does. The native capture module sends a 16 kHz copy of the audio (`onPcm`) only while it is asked for (`setLivePcm`); paused audio is not sent, and an app build without the new module records as before with no live text. The live text helpers `groupLiveTurns`, `tidyLiveText` and `tidyPartialText` are now in `@opengeni/react/recordings`, so a phone and a web page join live text the same way.
