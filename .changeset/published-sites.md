---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/core": minor
"@opengeni/codemode": minor
---

Sites can now be published to the web. A Site's owner or a workspace admin can give it its own address under the deployment's Sites domain (for example `team-crm-4k9x.opengeni.site`) and choose who can open it: workspace members, invited people who sign in with their email, or anyone, with anonymous visitors as guests. Published Sites keep their Site Data and embedded agent, but their direct tool calls return 403 (tools need a person's session in the console), and only a workspace admin can give the embedded agent workspace tools (guests get them only with `agent.guestTools`). Site code reads the viewer with `site.viewer` and starts sign-in with `site.auth.signIn()`, and no Opengeni credential reaches the Site. Collections gain a guest rule (`none`, `read`, `append`, `own`). Embedded agent use is paid by the organization under a limit profile (free, credits, unlimited or custom) per workspace and per Site. Visitors can report a Site, and managers can take it down and restore it. Breaking: Site HTTP is limited to an explicit operation allowlist (`SITE_OPERATIONS`) in every host, so a console Site that called other API routes through the bridge is now refused. The SDK adds `getSitePublication`, `updateSitePublication`, `unpublishSite`, `checkSiteHostname`, `takeDownSite`, `restoreSite`, `listSiteAbuseReports`, `updateSiteAbuseReport`, `getSiteLimitProfile`, `updateSiteLimitProfile` and `authorizeSiteViewer`; `ArtifactSandbox` and `SiteView` accept a `viewer`; agents get `site_publication_get`, `site_publication_update` and `site_hostname_check`. Publishing is off until `OPENGENI_SITES_DOMAIN` is set.
