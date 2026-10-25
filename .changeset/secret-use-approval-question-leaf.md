---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

The session-only React entry no longer reaches `@opengeni/contracts`. Telling a secret approval card from an ordinary question now comes from the new zod-free `@opengeni/sdk/secret-use-approval` subpath (`secretUseApprovalIdFromQuestionId`, `secretUseApprovalQuestionId`, `SECRET_USE_APPROVAL_QUESTION_PREFIX`), backed by `@opengeni/contracts/secret-use-approval-question`; the contracts root still exports the same helpers.
