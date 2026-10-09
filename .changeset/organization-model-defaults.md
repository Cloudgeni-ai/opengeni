---
"@opengeni/sdk": minor
---

Organizations can set model defaults once for every workspace: the default model for new work, Allowed models and context compaction limits by model. Each workspace follows them until its admins change a value for that workspace, and every row says which it uses: "Following Acme" or "Changed for this workspace", with a way back. The organization's Models page opens with these defaults, and workspaces that change any of them are marked in its workspace list. Allowed models and Context & compaction opened from the organization's page now edit the organization's defaults instead of one workspace.

SDK: `getOrganizationModelDefaults`, `updateOrganizationModelDefaults` and `deleteWorkspaceModelAccessPolicy`; the workspace model policy reports its `source` and the `organization` policy, compaction policies report `organizationTokens`, and the default model can come from the `organization`. Workspace settings accept `sessionDefaults: null` to follow the organization again. Rolling migration 0690 adds the organization table and removes workspace policy rows that allowed every model, which already read the same as no row.
