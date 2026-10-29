---
"@opengeni/sdk": major
"@opengeni/react": patch
---

Removed the deprecated surfaces that nothing uses any more:

- The first automation API (`/v1/workspaces/:workspaceId/automations/*`, `POST /v1/webhooks/automations/:endpointId`, `@opengeni/sdk/automations` and the `automationRunWorkflow`) and PR Review built on it (`/v1/workspaces/:workspaceId/pr-review/*`, the Opengeni Lens GitHub App connect flow, `@opengeni/sdk/pr-review` and the `OPENGENI_PR_REVIEW_GITHUB_*` settings). Automations are scheduled tasks with event triggers; pull-request review is one of their templates.
- Resumable transcription recordings (`/v1/workspaces/:workspaceId/transcription-recordings/*` and their SDK methods). Recordings and the live transcription stream replace them.
- The retired Knowledge search routes that only answered `410 gone`, and the "retired action" entries of the app action catalog.
- The deprecation-notice machinery: the API no longer sends `Deprecation`/`Sunset` headers and the SDK no longer has the `onDeprecation` option or `parseDeprecationNotice`.
- The response-header compatibility for SDKs up to 7.x: responses always carry `x-opengeni-api-contract`.
