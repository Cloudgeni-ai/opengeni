---
"@opengeni/desktop": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

The desktop app asks whether to record a call on a card of its own in the top right corner of the screen, instead of in a system notification. Focus and Do Not Disturb hid the notification, so a person in a call often never saw the question. The card shows above full-screen apps on every desktop and space, never takes the keyboard from the call, and has two buttons: Record and Not now (or Stop recording and Keep recording when the recorded call ends). A question to record goes away after 45 seconds unless the pointer is on it; a question to stop stays until answered. Closing or ignoring a question no longer holds back the next call's. Each question and its outcome is written, with the call app's id and the time only, to `meeting-detection.log` in the app's logs folder.

Any Electron app that shows Opengeni's meetings can now offer this too. `@opengeni/desktop/meeting-detection` exports `createMeetingDetection` and `handleMeetingDetectionIpc` (with the card's words, so an app can show them in its own language), and `@opengeni/desktop/preload/meeting-detection` exports `exposeMeetingDetection()`, which defines `window.opengeniMeetingDetection`. The meeting recorder uses it when the Opengeni desktop bridge is absent (`getDesktopMeetingDetection` in `@opengeni/sdk/desktop-bridge`). A choice now waits up to a minute for the page to listen, so choosing Record while the window is closed still starts recording once it opens, and Stop recording goes to the page that records.
