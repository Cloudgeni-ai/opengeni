---
"@opengeni/runtime": patch
---

Surface the Connected Machine (selfhosted) exec-deadline hint on the stdout-only SDK path: when a command is killed at its exec deadline, `execCommand` now returns the "terminated at the N-second limit — run long jobs in the background and poll" hint as its output (alone when stdout is empty, appended after the partial output otherwise), instead of returning an empty string the model reads as "no output". The structured `exec()` result is unchanged (the hint stays on stderr for the Channel-A parsers); it now also carries a `timedOut` flag.
