---
"@opengeni/react-native": minor
---

Android voice calls can be system calls, and agents can ring Android phones. With the config plugin's new `call.androidSystemCall: true`, a call is a self-managed Telecom call with a call notification and a phone-call foreground service, so it keeps going with the screen off, a cellular call holds it, and headsets and watches answer and hang up. It starts on the loudspeaker (or a connected headset) before voice starts, so the route does not change under a live call. When the app uses expo-notifications, an agent's call push rings the phone with the incoming-call notification and a full-screen ring screen on the lock screen, and answering or declining reaches JavaScript through the same `incoming` adapter and events as on iOS.
