---
"@opengeni/runtime": patch
---

computer_act can run a batch of semantic and keyboard actions in one call: they run in order on the same window, each acting on the state the one before it left, stop at the first that does not complete, and return the window's state after the last. A known sequence, such as pressing a run of Calculator buttons or filling several known fields, now takes one tool call instead of one per step. Each action stays its own durable operation, so a retried call repeats the same operations instead of acting twice.
