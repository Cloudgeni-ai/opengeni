---
"@opengeni/worker-bundle": patch
---

Less waiting between a model response and the next model request. A tool's result is now recorded as soon as its response's usage and tool calls are saved, instead of waiting for that response's billing writes and history checkpoint; the next model request still waits for both. The task usage receipt that the saved usage event already records is no longer written a second time, and the model-call slot is released before the response's history checkpoint, which the next request still makes durable before it is sent.
