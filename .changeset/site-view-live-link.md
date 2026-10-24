---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

The Site view header links to the published Site. "Live ↗" opens the Site's primary public address (in the desktop app, in the default browser) and a copy button copies it, for anyone who can open the Site; an unpublished Site says "Not published", with Publish for people who can publish. `GET /v1/workspaces/{workspaceId}/published-artifacts/{siteId}/publication/link` (SDK `getSitePublicationLink`, contract `SitePublicationLink`) returns a Site's published URL, hostname and status to anyone who can read the Site; the publication's settings stay behind `getSitePublication`. `ArtifactSandbox` and `SiteView` accept a `liveStatus` slot that replaces or hides the header's "Live" indicator.
