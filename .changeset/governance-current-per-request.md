---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

A turn runs each model request under the workspace governance that is active when the request is built. Before, a turn kept the instruction policies and organization profile active when it was accepted, so a turn that waited (for subscription capacity, a recovery or a long tool call) could act hours later on rules an owner had since changed. Each attempt now snapshots the governance active when it runs; a change the attempt sees during its turn is appended to the history as a new governance item before its next request, so earlier items stay unchanged and the prompt cache holds. A change made while an attempt runs is picked up by that same attempt before its next request: it refreshes its snapshots in place and appends the new governance, with no restart or recovery. Learning modes and Skill descriptors stay frozen for the turn.

`@opengeni/db` adds `refreshSessionWorkspaceGovernance` and `workspaceGovernanceSnapshotsAreCurrent`. Migration 1453 resolves the snapshots at attempt time, lets the snapshot routines refresh the running attempt's snapshot in place (the only update the immutability triggers allow), and lets a turn's Company Brain selection receipt keep its first governance hashes.
