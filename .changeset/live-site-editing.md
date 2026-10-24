---
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Sites are edited live in the console's Site view. Every way into a Site opens it there, with its chat beside it; Edit with Opengeni starts a new conversation in that panel. The conversation knows its Site, a publish or restore reloads the preview in place, versions published elsewhere show within seconds, and a version chip offers the history and one-click Undo.

New public API: `SessionConversation` `onEvent` (each event that arrives after its history loaded); `SiteView` `versionId`, `watch` and `versionControl`; `ArtifactSandbox` `liveState` (Updating or Reconnecting, shown beside the Live indicator or its `liveStatus` replacement) with the `SiteLiveStatus` type and the `liveUpdating` and `liveReconnecting` labels; `ArtifactSandbox` `frameKey`; `siteConversationContext` in `@opengeni/contracts/site-session-http`; `GET /v1/workspaces/:workspaceId/published-artifacts/:artifactId/current` with `getWorkspaceArtifactCurrent` and `WorkspaceArtifactCurrentResponse` in the SDK, which the Site view uses to check for new versions without reading their history.
