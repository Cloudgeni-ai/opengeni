---
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A meeting's transcript no longer waits for its compact kept audio. Each track is decoded once, straight to 16 kHz speech PCM (seconds even for an hour), and transcribed, told apart and searched for sound from that; the 16 kbit/s Opus kept copy, which takes most of a minute to encode for an hour, is written beside the transcript from the same downloaded chunks. The uploaded chunks stay until the attempt's transcript is settled, so a retry decodes exactly the same samples and reuses every piece already heard. Pieces of speech PCM are cut from the samples in-process and sent as FLAC to a model that takes it (WAV to a model that names no formats). The meeting page and `useRecording` keep polling a ready meeting for up to ten minutes after it ends while an audio track is still being kept, and the player waits for every track.
