---
"@opengeni/react": patch
---

Keep modal content above its backdrop when an extension reorders body children.

If you customize a Dialog or Sheet content exit animation, set `--og-modal-exit-duration` on its overlay to at least the full exit time so the overlay stays mounted until the content animation finishes. Use the matching SDK `Dialog` or `Sheet` root for non-modal dialogs rather than a raw Radix root.
