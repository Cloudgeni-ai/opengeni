---
"@opengeni/react": patch
---

Let slow browser inventory reads finish when refresh events arrive. Combine pending refreshes into a trailing read, while still canceling obsolete reads when the workspace, client, or enabled state changes.
