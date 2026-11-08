---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Distinguish an enabled connector left out of a chat's tools from a missing account during integration discovery. Such a connector no longer produces a misleading "Not connected yet" notice or an unnecessary Connect card through tool search. The response explains the chat selection instead; execution permissions and account selection are unchanged.
