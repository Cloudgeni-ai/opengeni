---
"@opengeni/react-native": minor
---

Localizable native session surfaces: every string the native timeline, session screen, signals, actions, queue dock and dictation strip draw now comes from `NativeTimelineMessages` (English defaults), overridable with `NativeTimelineMessagesProvider` or the session screen's `timelineMessages` prop. `NativeSessionScreen` also gains `renderComposer`, which receives the exact `SessionComposer` props so a host can restyle the composer or supply its own.
