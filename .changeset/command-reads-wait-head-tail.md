---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Background-command reads take fewer calls and fewer tokens. `command_read` now waits for a running command to finish (30 seconds by default; pass `waitSeconds: 0` to read at once), and both `command_read` and `command_wait` return when the command finishes or the wait ends, not on each new line of output. `command_wait` can wait on up to eight commands at once with `commandIds` and `waitFor: "all"` or `"any"`. A read without a cursor whose output is larger than the byte budget now returns its start and its end, with the approximate size of the omitted middle and a cursor to read it, instead of only the first page; a read with a cursor pages on from there, so `nextCursor` still pages through every byte, and the new `endCursor` reads only newer output. The model sees these results as plain text (state, exit code and output); Codemode and other programmatic callers keep the structured result.
