---
"@opengeni/runtime": patch
"@opengeni/core": patch
---

Preserve run_on secret references through the tool gateway so the existing target-shell delivery path sends values only through per-command environment variables or private files, never inline command text. Restore secretfile support and single-pass escaping for one-off machine operations.

Preserve structured secret failures and their missing-secret or per-use approval cards at the run_on boundary.
