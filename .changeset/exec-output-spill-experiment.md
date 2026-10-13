---
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Add an opt-in experiment, `OPENGENI_EXPERIMENT_EXEC_OUTPUT_SPILL=true`, that writes large `exec_command`/`write_stdin` output (more than ~2,500 tokens) to `tool-results/exec-<call id>.txt` in the sandbox and shows the model the banner, the first and last lines and the file path. The session timeline still shows the full output. Off by default.
