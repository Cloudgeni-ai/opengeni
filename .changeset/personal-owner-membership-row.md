---
"@opengeni/db": patch
---

The owner of a Personal workspace now has a real member row in it. The row is created with the Personal workspace, removed when the owner's organization membership is suspended, revoked or ended, and restored when it becomes active again. A batched backfill gives existing Personal workspaces their row and normalizes legacy owner rows. The row carries the fixed Personal permissions (workspace admin minus member management, workspace API keys and usage-allowance management), and the database still refuses every other member, moved rows and widened permissions. Access is unchanged: the verified owner still reaches Personal through the organization membership, nobody else can, and the tenancy checks now expect exactly this one row.
