---
"@opengeni/browserd": patch
---

Computer use: `set_value` true or false (or on, off, checked, 1, 0), `select` and `deselect` on a checkbox or switch press it only when it reads the other state, so a form with checkboxes fills in one batch. A checkbox named by role and name in a later batch step is read as the step runs (CUA fork `toggle_to`, pinned at 673780cd0), and a press that does not take fails the step.
