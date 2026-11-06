---
"@opengeni/core": patch
"@opengeni/db": patch
---

Model usage is now charged its full price after use. Agent turns and single model calls used to settle through `applyCreditDebitUpToBalance`, which debited at most the eligible balance left at settlement, so parallel or long calls that cost more than what remained were recorded as usage but never fully charged. They now settle through `applyCreditDebitAfterUse`, like voice input, Knowledge search, web search and Sites: covering promotional and plan credit pays first where it is eligible (with the credit policy revision the call was admitted under), API-origin use is still paid from credits only, and any shortfall takes general credit below zero, which later grants and top-ups net against. Admission is unchanged. A retry never charges a settled response again, including a zero-cost or capped receipt written by an earlier release. `applyCreditDebitAfterUse` accepts `creditPolicyRevision` and returns `grantDebitedMicros`; the unused `applyCreditDebitUpToBalance` and `planCreditDebit` are removed.
