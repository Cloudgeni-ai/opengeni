---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Your GitHub's action approvals have a fourth choice, **Settings and deletions** (group `sensitive` in `GET`/`PATCH /v1/workspaces/:workspaceId/github/action-policies` and the `updateGitHubActionPolicy` app action), next to Create and update work, Submit reviews and Merge pull requests. It covers what agents do as the person with `gh` and Git that is hard to undo: repository settings, secrets, variables and environments, deletions, tag and default-branch rewrites, and requests the gateway doesn't recognise. These used to ask every time with no way to change it; they now follow this choice. It defaults to Ask, so nothing changes until the person picks Allow (or Block). A connection-wide Allow for every GitHub tool doesn't cover it, and a connection-wide Block covers it only while it has no choice of its own. Writes whose repositories the gateway can't confirm (account and organization writes, unreadable requests, unresolvable GraphQL nodes) still always ask while the person allows only chosen repositories (or removed one from the chat), because the repository allowlist can't apply to them; with All my repositories at write access they follow the policy too. An approved request that is sent again keeps the policy action it was recorded under, so it still runs if the gateway classifies it differently the second time. The workspace app has no such group: a personal actor's `groups` carries `sensitive` (`PersonalGitHubActionPolicyGroup`, also the type of the update request's `group`), and setting it for the app answers 400.

Deleting or force-updating an agent's own branch now follows Create and update work when `gh` encodes the branch's slashes (`git/refs/heads%2Fmy%2Fbranch`, as `gh pr merge --delete-branch` sends), instead of always asking.
