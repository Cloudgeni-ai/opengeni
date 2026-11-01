---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

A Personal workspace now has exactly one possible member, its owner, enforced by the database (migration 1159). Nobody else's membership row can be added or moved into it, the owner's row can never manage members, workspace API keys or usage allowances, and a Personal workspace keeps its identity. Creating a workspace with the Personal external source now returns 422. Membership readers ignore a row in a Personal workspace, so the owner still reaches it only as the verified owning user. This prepares for giving the owner a real membership row in a later release.
