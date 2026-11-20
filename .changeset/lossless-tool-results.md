---
"@opengeni/codex": minor
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/react": patch
"@opengeni/runtime": minor
"@opengeni/tool-gateway": patch
"@opengeni/worker-bundle": minor
---

Tool results no longer lose data. One result now shows the model up to 25,000 tokens (100,000 bytes) of text by default, up from 10,000 tokens (about 48 KB), the same as Claude Code's default MCP output limit. A larger result is stored whole as a workspace File and the model sees its start (shell output: its head and tail), the total size and the exact `tool_result_read {"resultId","offset"}` call that reads the rest from durable storage, with or without a sandbox. This replaces both the head/tail cut that dropped the middle of results between about 48 KB and 1 MiB and the separate over-1 MiB spill. `tool_result_read` is never in a first-request tool list: the model loads it by exact name through tool search, so no session's tool list changes. Only newly produced results change; history already sent replays byte for byte.
