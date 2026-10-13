---
"@opengeni/api-router": minor
"@opengeni/core": minor
---

Agents can choose a Site's audience. `artifacts_create` takes an optional `visibility` (`private` or `workspace`); without it, a Site published from an Only me chat starts Only me and other Sites start shared. `artifacts_list`, `artifacts_get_source` and the create, publish, rollback, archive and restore results include each Site's `visibility` and `ownerSubjectId`. Agents still cannot change an existing Site's audience; only its owner can, from the Site page.
