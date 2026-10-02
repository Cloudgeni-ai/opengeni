---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

A send that names a model no longer in the live catalog now returns its 422 with `details: { code: "model_unavailable", modelId }` (the status, code and message are unchanged). `@opengeni/react` maps it to plain composer copy, offers Edit message instead of a Retry that cannot succeed, and exports `COMPOSER_MODEL_UNAVAILABLE_MESSAGE` and `isModelUnavailableSubmissionError`.
