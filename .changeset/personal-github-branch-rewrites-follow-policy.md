---
"@opengeni/api-router": minor
"@opengeni/runtime": patch
---

Deleting or force-updating a branch other than the repository's default branch as the person now follows the person's GitHub "Create and update work" setting instead of always asking, so with Allow an agent can rebase and force-push its own pull request branches and delete merged ones without stopping for approval. This applies to `git push` (force pushes and ref deletions) and to `gh` requests through the personal GitHub gateway (REST `git/refs` deletes and forced updates, GraphQL `deleteRef`, forced `updateRef`, and `updateRefs`). Force-updating or deleting the default branch, deleting or force-moving tags, and anything the gateway cannot confirm still always ask; with Ask first every rewrite still asks, and Block still wins. The gateway reads the default branch with the person's token (cached for a minute per connection and repository), and Git pushes use the default branch from the live repository check the broker already makes. In managed sandboxes with a repository mounted as the person, the agent prompt says so in one sentence.
