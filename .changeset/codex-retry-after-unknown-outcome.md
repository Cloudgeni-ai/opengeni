---
"@opengeni/db": patch
---

Retrying a failed Codex turn works again after a provider error left one request with an unknown outcome. Before, the retry's first model request was refused, so the turn failed again as not retryable. Automatic recovery stays fenced: a replacement attempt after a lost worker, or a resume after an approval or capacity wait, still cannot send a request while an earlier one is unresolved.
