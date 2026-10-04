---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Metered voice input: add the `azure-mai` voice-input provider id and the `insufficient_credits`, `allowance_exhausted`, and `monthly_model_cost_limit` transcription error codes, which resumable recordings now also report as their `errorCode`. The composer transcription control adds `errorInsufficientCredits`, `errorAllowanceExhausted`, and `errorPolicyBlocked` messages; a caller whose payer cannot be verified now sees a policy refusal instead of a microphone-permission error.
