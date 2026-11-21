# apply_patch `then` and one call for decided edits

The function `apply_patch` tool now takes an optional `then` command (run
through `exec_command` after the patch applies, with its result in the same
tool output), and its description notes that one patch can change several
files. One sentence follows the apply_patch rule in the sandbox file-editing
paragraph, in the modular `sandbox` module and in the legacy contract alike,
so modular and legacy stay in parity and no `diff` line is needed:

> Put all the edits you've decided on into one `apply_patch` call, and pass any
> check you'd run right after them as `then`.

Why it is general: an edit is almost always followed by a check (tests, a
build, a type check) in the next model step, and several decided edits are
often sent as separate calls. Naming the check in the edit call and batching
decided edits saves round trips and re-sent context for every coding task.

Size: 122 bytes more for every session with a sandbox or Connected Machine
(modular) and every legacy session; sessions without compute are unchanged.
The tool list changes too (`apply_patch` description, its `patch` example and
the new `then` property). The text depends only on the deployment setting
`OPENGENI_EXPERIMENT_APPLY_PATCH_THEN` (default on; false restores the
previous bytes), so every live session pays one cold prompt prefix after
deploy and nothing changes within a session.
