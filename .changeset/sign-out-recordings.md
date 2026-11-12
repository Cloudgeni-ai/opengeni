---
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Signing out no longer leaves a person's unsent meeting and dictation recordings on the device. When recordings of theirs are still uploading, the console, the desktop app and the mobile app first ask whether to wait for the upload (they stay signed in) or discard the recordings and sign out; with nothing pending, sign-out is unchanged. Where nobody can be asked, such as a sign-out from another tab, the recordings are discarded. Signing out of one browser account removes only that account's recordings; the last account, or signing out of all, removes every one.

For apps: stored recordings can carry an `ownerId` (`RecorderOptions`, `UploadRecordingAudioOptions` and `useRecorder`), which `localRecordingsOf` and `discardLocalRecordingsOf` use, and `useRecorder` finishes only its owner's recordings when it mounts. `prepareRecordingsForSignOut` (from `@opengeni/react/recordings` and `@opengeni/react/meetings-recorder`) runs the check before a sign-out, with `setSignOutRecordingsPrompt` for the question. On phones, the `opengeni-recordings` folder is kept off iCloud backups, the recording config plugin keeps it off Android backups and device transfers, and `forgetRecordingStore` deletes an account's folder.
