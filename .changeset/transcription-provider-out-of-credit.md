---
"@opengeni/core": patch
---

A meeting whose transcription provider has run out of credit now fails as out of credit (`provider_quota_exceeded`), which the meeting page explains with "top it up, then transcribe again" and an offer to transcribe with another provider, instead of saying the provider rejected its key. ElevenLabs answers a spent balance with 401, OpenAI with 429 `insufficient_quota` and Azure Speech's free tier with 403; the providers now read the error body to tell these apart from a wrong key or a rate limit, and voice input keeps the provider's own reason so a meeting transcribed through it reports it too. Live transcripts on a spent account say there is no credit left.
