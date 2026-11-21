---
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/network": patch
---

`OPENGENI_EXPERIMENT_TOOL_EFFICIENCY` gates a bundle of tool-efficiency changes: lossless compaction of command output (ANSI escapes, `\r` progress states, repeated lines, whole JSON bodies), parallel tool calls requested with an example in the existing parallel-calls rule, a starting-context history item (Git status, top-level listing, AGENTS.md) on a session's first turn, and whitespace-tolerant patch matching when a hunk matches exactly one place.

Responses that the socket transport does not carry are labelled `http; reason=not_eligible`, and a deployment with the socket transport turned off labels its responses `http; reason=disabled`.
