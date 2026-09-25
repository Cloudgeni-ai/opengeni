---
"@opengeni/github": patch
"@opengeni/api-router": patch
---

Integration OAuth callbacks now land on a real page when they fail. A callback whose state is only too old returns to that workspace's Plugins page with `reason=state_expired`; an unreadable state returns to `/integrations` with `reason=state_invalid`, which the web app forwards to the current workspace. Clicking Cancel at the provider reports `reason=access_denied` instead of an expired attempt. New OAuth starts default their return path to `/workspaces/:id/plugins`. GitHub App browser routes (connect, setup, install and OAuth callbacks, installation select and configure, manifest callback) render a readable page with a way back instead of a JSON error body, keeping the same status code. `@opengeni/github` adds `inspectSignedState`, which verifies a signed state without its age limit for explaining failures only.
