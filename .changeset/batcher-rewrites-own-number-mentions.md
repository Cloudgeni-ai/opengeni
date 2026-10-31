---
---

Merge batcher: moving a queued PR's migration off a number main already uses no longer stops at the PR's own mentions of that number. A changeset, doc, comment or test title that says "migration 1143" without the full `1143_slug` used to eject the PR for manual renumbering. The batcher now rewrites a bare number on lines the PR wrote (lines main's copy of the file lacks), when the number can mean nothing else to the PR's author: the PR adds no other migration with it, and main had none when the PR branched. Lines main already had keep their numbers, since they name main's migrations. Anything still ambiguous is left to a person as before.
