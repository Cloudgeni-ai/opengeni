---
"@opengeni/runtime": patch
---

Agents that can drive a browser or computer now always know that CAPTCHAs are theirs to solve. The rule moved from the secrets instructions, which only some sessions receive, into the `browser_open` and `computer_open` tool descriptions, which every session with those tools sees from its first request.
