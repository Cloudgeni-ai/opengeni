---
"@opengeni/react": patch
---

The session workspace dock no longer polls the machine fleet for viewers who cannot read it. `<SandboxWorkspace>` and `useSandboxWorkspaceTabs` accept `machinesEnabled` (default `true`); Opengeni's web app passes the viewer's `enrollments:read` grant. A 401, 403, or 404 from the fleet read now stops the 15-second poll until the read is disabled and re-enabled or explicitly refreshed. In the web app, Organization → Billing reads workspace budgets four workspaces at a time and requests this month's usage only for workspaces the viewer belongs to, and a refused Add people candidate list is not requested again when the page remounts.
