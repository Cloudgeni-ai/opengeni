---
"@opengeni/sdk": patch
---

Capabilities › Skills has a filter next to the search: All, Yours, Workspace or Organization. The Skills list API and `listWorkspaceSkills` take `scope` (`user`, `workspace` or `organization`) and filter on the server, so paged lists stay correct.
