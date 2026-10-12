---
"@opengeni/codex": patch
---

A Codex turn survives a brief provider 5xx again. An HTTP 5xx answer from the provider (for example a 503 after an upstream reset) is now recorded as a definite refusal rather than an unknown outcome, so the client's normal retry can send a new request instead of the whole turn failing. Timeouts (408, 504), conflicts (409) and missing responses stay ambiguous and are not replayed.
