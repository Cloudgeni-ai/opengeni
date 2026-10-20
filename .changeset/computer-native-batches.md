---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

On computers whose CUA driver supports it (macOS and Linux), a computer_act batch of semantic and keyboard actions now runs as one CUA operation checked against one observation, instead of one operation per action, which roughly halves the time of a long batch. Whether a computer session runs batches this way is fixed for the session's life, so every try of one batch, including tries on either side of an agent update, runs it the same way and never repeats its actions. CUA Driver is updated to 0.37.
