---
"@opengeni/react-native": minor
"@opengeni/react": minor
---

New `@opengeni/react-native/meetings` entry, so an app can add meetings to its phone app with the same screens the Opengeni app uses. `MeetingRecorderProvider` holds one recorder above the screens (recording keeps going while the person moves around the app or locks the phone), `MeetingsList` is the meetings page with the recorder on top, and `useMeetingView` gives one meeting's transcript plus the actions for the host's own header menu. They read the client and workspace from `OpenGeniProvider`, take an `externalRef` to scope a list (and new recordings) to something in the host, and every label comes from the shared Opengeni catalog under `native.meetings.*`, so hosts translate them like the rest.
