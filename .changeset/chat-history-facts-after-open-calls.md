---
"@opengeni/runtime": patch
---

Switching a chat from an OpenAI Responses model to a Chat Completions provider (for example an OpenAI-compatible connection whose gateway forwards to Claude) no longer fails with "unexpected tool_use_id found in tool_result blocks" when an earlier step ran tool search, computer, shell, patch, hosted or namespaced tools in the same parallel batch as ordinary function calls. Their readable historical facts, and runtime notices that fell inside the step, now come after the step's last tool result instead of between the calls and their results, in the same order on every request. Native Claude also accepts such a fact or notice that fell between two results of one step: it moves to just before the step's first result.
