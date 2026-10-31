---
"@opengeni/db": minor
"@opengeni/core": minor
---

A personal (Only me) login's tool choices (Allow, Ask first, Block) now belong to the login and follow it between workspaces. They are kept once, in the workspace the login was connected from: saving them from any workspace stores them there, and a turn in another workspace that uses the login starts with them (`connectorActionPolicySnapshotForTurn`). Before, each workspace kept its own copy, so the same login asked again in every new workspace. Rolling migration 1145 merges existing copies into the login's own workspace, where the strictest choice wins (Block, then Ask, then Allow) and ties go to the most recent. Workspace logins and credential-free servers keep their workspace's choices.
