---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A model switch made in the chat (for example when the agent calls `session_set_model`) now takes effect and shows in every composer. Composer drafts gained `modelProvided`: false while the draft follows the chat, true once the person picks a model, reasoning or latency in the composer. A draft that follows the chat shows the chat's current policy, reloads on `session.model_settings.updated`, and its send runs on the chat's model without changing it, so a stale composer can no longer undo the switch. A picked policy still becomes the chat's policy when sent, and the next draft follows the chat again. Saves and submits without the flag, from older clients, keep the previous behaviour. Existing drafts start out following the chat. `session_set_model` now reports the policy read back from the stored session.
