---
"@opengeni/contracts": minor
"@opengeni/runtime": patch
"@opengeni/react": patch
"@opengeni/sdk": minor
---

The Branch view in Changes and the branch comparison stored with workspace captures now show only the changes made on the current branch, measured from where it left the default branch, like a pull request. Before, a checkout that had fallen behind the default branch also listed every later change on the default branch, reversed. Git diff requests take a new optional `mergeBase` flag for this.
