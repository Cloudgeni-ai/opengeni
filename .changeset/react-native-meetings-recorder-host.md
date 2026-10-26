---
"@opengeni/react-native": patch
---

`MeetingRecorderProvider` from `@opengeni/react-native/meetings` now runs its recorder beside the screens instead of around them. A new `storeScope` or workspace starts a fresh recorder without remounting everything below it, so an app can switch account or organization without a `key` that resets its navigation. The live snapshot only re-renders the components that read it, not the whole app several times a second while recording. `workspaceId` may be `null` while the app is still finding it.
