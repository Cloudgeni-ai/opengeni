---
"@opengeni/sdk": patch
---

Pull-request review is an automation now, and the first automation API is deprecated. `@opengeni/sdk/automations` (`OpenGeniAutomationsClient`) and `@opengeni/sdk/pr-review` (`OpenGeniPrReviewClient`) are marked `@deprecated`. Their routes, `/v1/workspaces/:workspaceId/automations/*`, `POST /v1/webhooks/automations/:endpointId` and the `/pr-review` registration, repository and GitHub setup routes, answer with `Deprecation` and `Sunset` headers and keep working until January 25, 2027; they are removed in the next major. Use event sources (`createEventSource`) and scheduled tasks with `events` instead; see the migration notes at https://docs.opengeni.ai/integrate/background-agents#moving-from-the-first-automation-api.

In the web app, the "Review new pull requests" automation template skips draft pull requests until they are ready for review and carries fuller review instructions, the automation form says when a GitHub trigger has no repository to open, and Plugins points to the template instead of offering a new Opengeni Lens setup where event triggers are on.
