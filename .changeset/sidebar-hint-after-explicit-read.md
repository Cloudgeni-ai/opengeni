---
"@opengeni/react": patch
---

A sidebar group no longer keeps a row another device archived or changed when that change arrives while an explicit "Show more" has failed or is still loading. The background refresh still leaves Retry and the loaded rows alone, but the group is now reread once the explicit read succeeds. Before, the stale row stayed until some later unrelated change reached the same group.
