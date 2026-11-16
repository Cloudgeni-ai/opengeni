---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A tool call the model asks for is saved before its tool starts, so a worker that stops mid-step can always recover it: the call is closed as interrupted instead of being lost and run again. The call is saved while the response's usage is billed, and the next model request still waits for both.
