---
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
---

A `git commit` or `git push` run through `exec_command` or `run_on` that would carry a secret value Opengeni filled in for a reference earlier in that sandbox is no longer run. The result names the file and line (and commit) and says how to write the reference literally instead. Matching is exact against a keyed ledger of resolved values kept in the sandbox; files that are not committed never block, and the command runs if the check itself fails. See "Keeping values out of commits" in `docs/secrets.md`.

The prompt, the `secrets` Skill and secret-resolution hints now say the backslash escape keeps a reference as literal text in files as well as commands. `apply_patch` resolves references only in added lines, so context and removed lines match files that hold a literal reference.
