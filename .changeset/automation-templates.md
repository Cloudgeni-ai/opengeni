---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

Automation templates and a "This workspace" event source.

- **Templates.** A template is where a new automation starts: its message, a schedule without a time zone, and event triggers that name a kind of source. Using one opens the ordinary form filled in; nothing is created until the person saves. `@opengeni/react/automations` ships built-in templates (`builtinAutomationTemplates(t)`, including "Meeting notes"), and `AutomationsPanel` takes `templates` (the host's own), `workspaceTemplates` (offer and save the workspace's saved templates, on by default) and `workspaceEvents` (offer this workspace's own events as a source, off by default). The new-automation view offers "Start from scratch", the host's templates and the saved ones; an automation's menu has "Save as template". `useEventSourceStandIns`, `AutomationTemplateList`, `AutomationTemplateTile` and `AutomationTemplateDialog` are exported for hosts that build their own.
- **Saved templates.** Workspaces keep the templates their people save: `GET`/`POST /v1/workspaces/:workspaceId/automation-templates` and `PATCH`/`DELETE …/:templateId`, with `listAutomationTemplates`, `createAutomationTemplate`, `updateAutomationTemplate` and `deleteAutomationTemplate` in the SDK. Reading needs `scheduled_tasks:run`, saving needs `scheduled_tasks:manage`; whoever saved a template and workspace admins can rename or delete it (`viewerAccess`). A workspace keeps up to 200; saving more returns 409.
- **"This workspace" source.** `createEventSource({ kind: "workspace" })` creates the caller's own source for the workspace's recording events (`recording.started`, `recording.finished`, `recording.transcript.ready` and the rest). It reads under the owner's row security, so a trigger only sees the meetings its owner may open.
