---
"@opengeni/runtime": patch
---

A Modal command whose output reads keep failing now reports that its output is unavailable instead of quietly looking like it is still running. After a failed read, the retry often had only a few milliseconds of the read's budget left, so it timed out before the provider could answer, and that timeout was treated as "no new output". Setup commands could then poll indefinitely without surfacing the outage. A retry now counts only when it actually returns output, end of output or the exit code.
