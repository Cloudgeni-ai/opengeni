---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A meeting transcript retried after its worker was lost no longer pays the provider again for audio it already transcribed. Each piece of a track is kept with its version as soon as the provider answers (before a text-only model's words are placed), keyed by the model, options, piece and a hash of the audio, and a retry reuses it. Kept pieces are removed when the version completes or fails (migration 1211).
