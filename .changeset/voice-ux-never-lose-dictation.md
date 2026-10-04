---
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Voice input never deletes a real dictation on Cancel, Escape, or when live voice takes the microphone: anything longer than a few seconds stops and stays saved on the device to transcribe or discard explicitly, and an Escape already handled by a dialog or menu is ignored. Dictation shows elapsed time and warns before the automatic stop. Saved/error explanations wrap instead of truncating, and on phones they take the controls row. Fixed dictation failing after a remount (React StrictMode) because the recording store was reused after close. Live voice: a definitive failure before the first connection ends the call and keeps the server's plain message visible (no "OpenGeni API 409" prefix or reference id), autostart makes one attempt instead of looping, the model menu says "Opengeni", and a disabled start control names its blocker. `useVoiceInput` exposes `recordingStartedAt` and `maxRecordingSeconds`.
