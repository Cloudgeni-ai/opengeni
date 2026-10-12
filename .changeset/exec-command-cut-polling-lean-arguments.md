---
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Shell commands in managed sandboxes now honor a model-requested foreground wait up to 4 minutes (was 30 seconds; Connected Machines keep their 30-second background yield), so a long build or test run returns its result in one `exec_command` call instead of repeated empty `write_stdin` polls. A command that printed output and then went quiet still returns after the ordinary 30-second window, and one that ends in an input prompt returns after 2 seconds of silence. `exec_command` also uses a lean non-strict schema that requires only `cmd` and `max_output_tokens`; omitted `login`, `tty` and `yield_time_ms` run as `false`, `false` and `10000`. Both are on by default; set `OPENGENI_EXPERIMENT_CUT_POLLING=false` or `OPENGENI_EXPERIMENT_OUTPUT_COST=false` to disable either.
