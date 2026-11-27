---
"@opengeni/react-native": minor
---

Minimizing a call from `NativeAgentCallProvider` always shows the screen underneath again. The full-screen call surface was a React Native `Modal`, a native presentation that competes with the app navigator's own modal screens: started while a native modal screen was up (such as a chat opened as a `fullScreenModal`), it could not present until that screen closed, and a minimize while that late presentation was still pending dismissed nothing, so the presentation then landed with no content and left a blank screen over the whole app. The surface is now a layer above the app instead: on iOS it is mounted in the window above every presented screen when it opens (react-native-screens' `FullWindowOverlay`), so it also shows over modal screens right away, and minimizing slides it away and unmounts it; on Android it is drawn above the app and Back minimizes. `react-native-screens` (4 or later) is now a peer dependency.
