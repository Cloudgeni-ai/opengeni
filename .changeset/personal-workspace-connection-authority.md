---
"@opengeni/core": major
---

Resolve a managed human's personal-workspace authority in the connection grant layer on top of the session-surface prerequisite's canonical workspace-authority resolver.

A managed human's personal workspace deliberately has no `workspace_memberships` row (migration 0219 raises on one); the owner's access is the `organization_memberships.personal_workspace_id` pointer. `getWorkspaceGrant` is a bare membership join, so every seam using it as a "does this subject still hold workspace authority here" predicate denied the one human who always belongs. In their own personal workspace, `freezePersonalConnectionDelegations` returned no delegations at all and Google Drive publication resolved no target. Those seams now use the pointer-aware resolver.

The landed session-surface prerequisite renamed the public database oracle to `namedSubjectHasLiveWorkspaceAuthority`, extracted the canonical in-scope authority rule, and declared the one required `@opengeni/db` major. This change consumes that landed API rather than declaring the same database break again. The named-subject wrapper continues to restore the caller's prior `opengeni.subject_id`; calling it on a transaction handle must never redefine who the rest of that transaction runs as.

**BREAKING (`@opengeni/core`):** `PersonalConnectionDelegationSource`'s `subject` variant now requires `accountId` — the personal-workspace pointer lives on an organization membership, so the account is part of the question. `personalConnectionDelegationSourceForGrant` supplies it.

**BREAKING behaviour change (`@opengeni/core`):** a delegated/bearer grant (`metadata.delegated === true`) now yields no personal-connection delegations **in any workspace**, including ordinary shared workspaces where it previously worked through a real membership row. A delegated payload's `subjectId` and `workspaceId` are signed token fields with no database row behind them, so treating that subject as authority to borrow a user's private provider credentials is not a boundary worth holding — in a shared workspace any more than a personal one. Embedding hosts minting user-facing delegated tokens lose personal X/Reddit/Atlassian/Google Drive delegation for those sessions; workspace-owned connections are unaffected. See `docs/embedding.md`.
