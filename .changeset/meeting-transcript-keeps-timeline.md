---
"@opengeni/worker-bundle": patch
---

Meeting transcripts and speaker names now stay in time with the recording when a capture
leaves small holes in its timestamps, as a desktop's computer-audio track can (33 seconds of
holes in an 8-minute meeting). Decoding closed those holes up, so words came out timed up to
half a minute early, and a model that decoded the audio itself could disagree with our speaker
turns. The worker now fills the holes with silence when it prepares a track, re-encoding it
instead of copying it, and in every decode it does itself, so every model, word alignment,
speaker detection and playback share the recording's own timeline. A track prepared before
this change is prepared again the next time it is transcribed.
