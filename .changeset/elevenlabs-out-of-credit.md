---
"@opengeni/core": patch
---

An ElevenLabs account out of credit fails a recording as out of credit (`provider_quota_exceeded`), not as a rejected key. ElevenLabs answers HTTP 401 with status `quota_exceeded` when the account's credits run out, which was read as `provider_unauthorized` and told the person their key was wrong.
