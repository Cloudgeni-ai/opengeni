---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

A turn runs each model request under the workspace governance that is active when the request is built. Before, a turn kept the instruction policies and organization profile active when it was accepted, so a turn that waited (for subscription capacity, a recovery or a long tool call) could act hours later on rules an owner had since changed. Each attempt now snapshots the governance active when it runs; a change the attempt sees during its turn is appended to the history as a new governance item before its next request, so earlier items stay unchanged and the prompt cache holds. A change made while an attempt runs ends it before its next request is sent (`workspace_governance_changed` recovery), and the next attempt continues the same turn under the new governance. Learning modes and Skill descriptors stay frozen for the turn.

`@opengeni/db` adds `refreshSessionWorkspaceGovernance` and `workspaceGovernanceSnapshotsAreCurrent`. Migration 1453 resolves the snapshots at attempt time and lets a turn's Company Brain selection receipt keep its first attempt's governance hashes.
