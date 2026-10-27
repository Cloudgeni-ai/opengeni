---
"@opengeni/db": patch
---

A published Site in a personal workspace now accepts follow-up messages from guests and signed-in visitors outside the workspace. Prompt admission refused every human-less prompt in a personal workspace with `PERSONAL_SESSION_OWNER_REQUIRED`, while the turn itself already starts there in the Workspace destination with learning off (migration 0868), so a visitor's first turn worked and every later message failed. Admission now treats only private and user-memory sessions as personal memory, matching the turn's own guard.
