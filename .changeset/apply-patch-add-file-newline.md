---
"@opengeni/runtime": patch
---

`apply_patch` `*** Add File` now creates files that end with a newline, matching Codex: each `+` line is followed by `\n`. Previously the last line had no trailing newline. Update and Delete File sections are unchanged, and internal sandbox writers keep their exact-content behavior.
