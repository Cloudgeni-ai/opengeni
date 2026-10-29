---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/worker-bundle": minor
"@opengeni/react": minor
---

Unattended sessions no longer wait on a person anywhere. A call that needs someone's approval under the workspace's tool permissions is refused at once with an error result saying nobody can approve it in an unattended session, in model tool calls and in Codemode, so the agent works around it and lists it as a step left for a person. Nothing is approved and no approval request is opened; permissions stay exactly as configured. Chats that scheduled tasks and event triggers start are unattended by default; a task chooses with `agentConfig.unattended`, and a task that sets `approvalTimeoutSeconds` without it stays attended. A new **Work without me** switch in a chat's Agent tab turns unattended mode on or off from the next turn, through `PUT /v1/workspaces/:workspaceId/sessions/:id/unattended` (SDK `updateSessionUnattended`); session reads include `unattended`. Explicit choices (the switch, the create option, a task's `agentConfig.unattended`) stay; only the automatic default of a scheduled or event-triggered chat ends when a person writes in it from the web app, Slack or a voice call. Interactive sessions are unchanged.
