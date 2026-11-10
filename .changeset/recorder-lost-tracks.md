---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

A meeting recording keeps a track whose source goes away instead of silently ending it. A microphone that is unplugged or turned off is opened again as soon as one is available and records on in the same track; shared tab or computer audio that ends waits for `recorder.reconnect(trackNumber)` (`reconnectTrack` in `useRecorder`), which asks again from a click. Snapshot tracks report `lost: "reconnecting" | "stopped"`, the recorder panel says what is missing and offers the click that brings it back, and `useMeetingRecorderLostTrack` lets a host show it outside the panel.
