---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

An answer the agent gives before waiting is now shown exactly as written. `wait_for_input` takes a `reply` argument that becomes the agent's message, and agents are told to use it whenever the turn answers someone. Before, Claude Opus 5.5 and Sonnet 5.5 returned an answer written just before the wait as a progress update, so people saw only a one-paragraph summary of it, without its images or tables.
