---
---

Fix native transactional file edits after normal machine enrollment. Preserve
per-operation session epochs and exact connection lifetime checks instead of
comparing session epochs with an unset machine hello epoch.