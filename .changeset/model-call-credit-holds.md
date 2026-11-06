---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Stateless model calls (`POST /v1/workspaces/{workspaceId}/chat/completions`) on a credit-billed model now reserve their maximum cost when they are admitted. Admission used to check only that the credit balance was positive, and settlement debits at most the remaining balance, so calls running at the same time could together use more than the balance and the rest was never charged. Now, under the account lock settlement uses, a call is admitted only when the spendable balance minus the holds of the account's other calls still in flight covers its input (one token per UTF-8 byte of text, a fixed allowance per image) and its output limit at the model's credit price; otherwise it is refused with `402` before any provider request. A request with no `max_tokens` / `max_completion_tokens` is sent with a 32,000-token output limit so that its cost has a maximum. The hold is released when the call settles, fails or is aborted, and a hold left by a stopped process stops counting after 30 minutes. Migration 1290 adds the `model_call_credit_holds` table.
