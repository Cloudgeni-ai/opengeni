---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Repository setup no longer deletes work in a repository folder. It used to wipe and re-clone a folder Git could not read (another owner after `chown -R`, a corrupt `.git`, an interrupted clone) or whose `HEAD` was not the pinned commit, which lost uncommitted files and unpushed commits. A folder another user owns is now added to the box's global `safe.directory` and kept. Any other unreadable or mismatched folder is renamed to `<folder>.opengeni-recovered-<UTC time>`, a fresh clone takes its place, and the model is told where the moved copy is (in the turn's input, or with the next tool result when the box starts on demand). A pinned clone records the commit it materialized, so the agent's own commits and branches stay in place until the pin changes. The `repository-clone` completed event lists each move in `recoveredRepositories`.
