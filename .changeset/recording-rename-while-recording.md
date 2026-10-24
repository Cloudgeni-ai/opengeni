---
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A meeting can be renamed while it records. `Recorder.rename(title)` (and `rename` from `useRecorder`) stores the title with the recording on the device: before the server has the recording it goes out with its creation, after that with the next upload pass, so a dropped connection only delays it; once the recording is finalized it goes straight to the server. The recorder snapshot now has the `title`. `RecordingTransport` may include `updateRecording`, which renaming needs once the server has the recording. The web recorder shows the meeting's name while recording, with Rename.
