---
"@opengeni/runtime": patch
---

Computer tools now give the model a compact text view instead of their full JSON. An observation lists one line per element it can read or act on (role, name, ref, value and meaningful states such as focused, disabled, collapsed or offscreen) and leaves out platform metadata, unlabeled containers and widgets that are not rendered. A Chromium window observed on Linux drops from about 85,000 characters to about 3,400. computer_open, computer_targets and computer_act use the same view, and the complete typed value stays in the structured result for Code Mode. computer_observe also reads the accessibility tree and the screenshot at the same time instead of one after the other.
