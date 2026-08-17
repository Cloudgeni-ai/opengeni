---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": patch
---

Make `retrieval_only` the default Company Brain memory prompt mode. An absent or unrecognized workspace `memoryPromptMode` now removes the broad Memory V1 standing block, excludes legacy preference-kind rows from agent search, and omits the company profile from child prompts; an explicit `legacy_standing` remains the per-workspace rollback opt-out. Rolling migration 0271 applies the same fallback at turn acceptance so frozen snapshots and the contracts resolver agree.
