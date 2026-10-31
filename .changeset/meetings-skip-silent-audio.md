---
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
---

Meeting transcription no longer pays to transcribe silence. Before sending a
track, the worker finds its quiet stretches (below -55 dBFS for at least
20 seconds). A track that is silent throughout, like the computer's audio in
a room meeting, is not sent at all. When our own diarizer tells the speakers
apart, or the model doesn't, only the stretches with sound are sent, each
with a second of margin. A model's own speakers don't carry across pieces, so
a track that relies on them is still sent whole. The transcript's provider
cost counts only the audio sent, and the new
`opengeni_recording_sent_audio_seconds_total` counter and the
`sentAudioSeconds` log field show it. `@opengeni/core` exports
`planRecordingSoundPieces`.
