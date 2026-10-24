---
"@opengeni/browserd": patch
---

Computer use: `set_value` true or false (or on, off, checked, 1, 0), `select` and `deselect` on a checkbox or switch press it only when it reads the other state, so a form with checkboxes fills in one batch. A checkbox acted on after another action of a batch is read as its step runs (CUA fork `toggle_to`, pinned at 7deb4e5fb), never from the observation taken before the batch, and a press that does not take is reported either way. A mixed (indeterminate) checkbox counts as neither state, and a later batch step may select or deselect a checkbox or switch the batch does not show yet.
