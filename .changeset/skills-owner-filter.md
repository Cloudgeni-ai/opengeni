---
"@opengeni/sdk": patch
---

Capabilities › Skills has a filter next to the search: All, Mine, Workspace, Organization or From plugins. The Skills list API and `listWorkspaceSkills` take `scope` (`user`, `workspace` or `organization`) and `installed`, and filter on the server, so paged lists stay correct.
