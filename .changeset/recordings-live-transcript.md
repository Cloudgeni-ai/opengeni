---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Add the live transcript preview for recordings. `createRecordingLiveSession`, `appendRecordingLiveSegments` and `listRecordingLiveSegments` on the recordings client; `createLiveTranscriber`, plus `liveTranscript` on `createBrowserRecorder` and `useRecorder`, which stream each track to a live speech model while recording and expose the text in `snapshot.live`; `useLiveTranscript` to follow a recording from another device; and `liveModels` from `useRecordingModels`. Tracks carry a `live` summary, and workspaces can turn it on by default with `settings.recordings.liveTranscript`.
