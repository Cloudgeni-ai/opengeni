---
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
---

A tool result too large to show whole now says so on its first line, before the content, as well as after the part shown, and new chats carry `tool_result_read` in every request, so the model can read on with one call instead of finding the reader through tool search first. A model `skill_read` of several files returns each file whole or not at all and names the files left out with the exact read. Existing chats keep their tool list, and results already sent replay unchanged.
