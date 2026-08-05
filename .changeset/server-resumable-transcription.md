---
"@opengeni/api-router": minor
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/worker-bundle": patch
---

Add production resumable composer transcription with exact-subject durable
manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
recording-wide provider pin, persisted retryable segment results, deterministic
assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
of transcript metadata after every provider object is confirmed deleted. Legacy
one-shot voice input remains compatible.