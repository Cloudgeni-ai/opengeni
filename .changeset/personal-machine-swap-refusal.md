---
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

When an agent switches to or runs on someone's personal (Only me) machine that the chat is not allowed to use, the swap now returns a typed refusal (`personal_machine_permission_required` or `personal_machine_not_permitted`) with a plain reason saying how the owner can allow it, and leaves the chat's route unchanged. Previously the tool failed with a raw database error. One-off `run_on` calls give the same reason.
