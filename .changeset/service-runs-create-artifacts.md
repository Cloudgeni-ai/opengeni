---
"@opengeni/db": patch
---

An agent in a scheduled run with no human owner can now create, publish, roll back, archive and restore Sites in its own workspace. The exact live attempt, the selected artifact tool and `artifacts:publish` still gate every change, and such artifacts are shared with the workspace with no Only me owner.
