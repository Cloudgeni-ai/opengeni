---
"@opengeni/db": patch
---

Human-confirmed Knowledge approvals now record truthful review reasons: migration 0277 adds a reason-carrying overload of `governed_learning_apply_knowledge_review`, and both human-confirmed callers (`confirm_remember_knowledge_claim` and `activate_human_confirmed_learning_decision`) pass an explicit human-confirmed reason instead of the hard-coded "Automatic governed-learning activation." wording; the 9-arg signature keeps that legacy wording for the automatic path and remains the guard-resolved capability writer.
