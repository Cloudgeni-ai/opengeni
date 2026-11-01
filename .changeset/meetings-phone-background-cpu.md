---
"@opengeni/react-native": patch
---

A phone meeting keeps recording with the screen locked. While the app was in the background, the recording screens still redrew several times a second (the level meter ran on the JavaScript thread and every clock, level and live-transcript change re-rendered the screens), which used enough CPU that iOS ended the app and the recording with it. Now the level meter is scaled on the native side and stops in the background, and `MeetingRecorderProvider` tells the screens nothing while the app is in the background; they get the latest state when it is back in front. Capture and upload are unchanged.
