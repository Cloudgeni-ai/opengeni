---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A tool call the model asks for is saved before its tool starts, so a worker that stops mid-step can always recover it: the call is closed as interrupted instead of being lost and run again. The response's usage is saved in the same write as its tool calls, before any of them runs; its billing runs alongside the tools, and the next model request still waits for it. If the worker stops, is replaced or its billing fails before billing finishes, recovery, the attempt's failure handling or the session's next idle point finishes it exactly once, at the price recorded with the usage. Recovery only looks at responses whose billing is still unfinished.
