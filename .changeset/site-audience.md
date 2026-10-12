---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Sites now have an audience, like chats and schedules: **Only me** or **Workspace**. An Only me Site is visible only to its owner, everywhere it can be reached: the Site page, versions, content and downloads, the artifact library, Site tools and Site conversations; admins cannot see it, as with an Only me chat. A Site published from an Only me chat starts Only me; other new Sites start shared unless `visibility` is set when creating it. The Site page shows who can see it and gives its owner a "Share with workspace" action (and "Limit to me" while Only me is allowed), each confirmed first. Only the owner changes the audience, through `PUT /v1/workspaces/{workspaceId}/published-artifacts/{artifactId}/visibility` or the SDK's `updateWorkspaceArtifactVisibility`; agents cannot. Sites expose `visibility` and `ownerSubjectId`, and artifact catalog items for Sites include `visibility`. Existing Sites stay shared with the workspace; migration 0734 records their owner.
