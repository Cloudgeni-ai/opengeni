---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Files can be shared like Sites. A file is Only me or visible to the whole workspace; a new file follows its chat, and its owner can share it or limit it again.

- `client.updateFileVisibility(workspaceId, fileId, { visibility })` changes who can open one file; only its owner can.
- `FileAsset.ownerSubjectId`, `FileAsset.access`, `CreateFileUploadResponse.access` and `SandboxFileArtifactReceipt.access` say who can open a file (`access.whoCanOpen` is one plain sentence). `ArtifactCatalogItem.ownedByViewer` marks files the viewer can share.
- `PublishSandboxFileArtifactRequest.visibility` chooses a published file's audience.
- Opening someone else's Only me file returns `403` with the retained-output reason `"private"`; a missing file is still `404`.
