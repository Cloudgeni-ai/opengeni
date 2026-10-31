---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Documents, spreadsheets and presentations can be Only me, like chats, Sites and files. One made by an agent in an Only me chat, or imported from an Only me file, starts Only me; everything else, including every existing one, stays shared with the workspace. An Only me one opens only for its owner and for agent turns acting for them or running in their own Only me chat; colleagues, workspace administrators, keys and services cannot read, edit, export or open it live, and the artifact library does not list it for them. A file an agent exports from it is Only me for its owner, even from a shared chat. Only the owner changes the audience, from the app: `PUT /v1/workspaces/:workspaceId/editable-artifacts/:artifactId/visibility`, the SDK's `updateEditableArtifactVisibility`, or the document's Artifacts menu. Create and import accept an optional `visibility`; editable artifact responses and catalog items carry `visibility` and `ownedByViewer`. A Site made in an Only me chat by a run without a person, such as a meeting summary, now stays Only me under the chat's owner. Rolling migration `1160_editable_artifact_audience.sql`.
