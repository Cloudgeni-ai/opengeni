---
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

A Site's sidebar row now moves only when the Site gets a new published version (creation is the first). Messages and turns in its conversations, including a side chat used to edit it, and activity in the chat that created or published it no longer lift it; a publish from any of them still does. Opening a Site, archiving, restoring and the version chip's Undo (a rollback, which adds no version) don't move it either. Opened Sites and Sites with conversations keep their rows in their own project, and session rows are unchanged. `SiteConversationGroup.updatedAt` is now the Site's newest publish. When there are more than 200 Site rows, the limit keeps pinned rows first and then Sites with recent publishes or conversation activity, so a Site whose conversation needs you stays in the sidebar.
