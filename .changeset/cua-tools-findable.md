---
"@opengeni/runtime": patch
---

Native CUA tools are easier to find and batch. Disclosing any `interaction__cua_*` tool now also discloses `interaction__cua_get_window_state` and `interaction__cua_run_steps`, so an agent that found `cua_click` can send a whole form as one batch instead of one call per field. Their descriptions say how the CUA tools they mention are named (`interaction__cua_<name>`, `interaction.cua.<name>` in Code Mode, plain names inside `run_steps` steps), and their Code Mode path moves from `computer.<name>` to `interaction.cua.<name>`. A computer observation whose accessibility tree has only hidden or unlabeled elements now says so instead of claiming the tree has no readable elements.
