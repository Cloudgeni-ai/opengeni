---
"@opengeni/runtime": patch
---

Keep authorized first-party harness control tools (goal lifecycle, `command_read`, `command_wait`, `wait_for_input`) visible from the first request on every progressive-disclosure transport, so the model no longer spends a `tool_search` round trip to find them. Other first-party tools stay deferred and a disabled family stays absent.
