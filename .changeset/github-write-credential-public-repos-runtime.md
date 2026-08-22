---
"@opengeni/runtime": patch
---

Sandbox setup on a shared box now removes a provider alias token file (`$HOME/.opengeni/git-token`, `git-credentials/github-token`, and the GitLab/Azure DevOps equivalents) that the current turn neither binds nor seeds, so a turn without a GitHub credential never inherits a sibling turn's expiring token. Renewal commands keep their binding-only scope.
