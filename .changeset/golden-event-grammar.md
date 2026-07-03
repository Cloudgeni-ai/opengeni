---
"@opengeni/react": patch
---

The timeline projection's event-grammar contract is now pinned by a golden fixture suite (8 realistic event-log fixtures → committed projection snapshots, including compact/raw equivalence and legacy/malformed tolerance). Intentional grammar changes regenerate snapshots so the diff is reviewed; unintentional ones fail CI.
