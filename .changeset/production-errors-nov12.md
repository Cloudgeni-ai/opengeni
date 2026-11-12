---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/observability": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Fix several failures seen in production:

- An attached file whose name merely contains two dots (such as `notes..txt`) no longer fails the turn. Sandbox file names still refuse empty, `.`, `..`, path separators and NUL, and uploads name a bare `.` or `..` `file`.
- A completed video from an Only-me chat is delivered to the chat. The reconciliation service read the result as a service actor that could not see the private chat, so the operation retried forever with "Completed video generation lost its retained artifact".
- Checking a session's work while the session is being deleted reports it idle instead of failing the activity with `SessionControlInvariantError`.
- A chat deleted while its title is generated ends the title operation quietly instead of warning "Independent session title failed".
- A caller that disconnects from `POST /v1/workspaces/:workspaceId/tools/{resolve,invoke,target-approvals,manifest}` gets the client-gone 499 (empty body) instead of a 500, counted as `aborted` in `opengeni_tool_target_operations_total`.
- The web app picks its root providers from the rendered route rather than the pending location, so navigating to Security settings or phone sign-in no longer shows "Opengeni app context is not ready".
- Temporal "Activity failed" / "Workflow failed" logs add `failureMessageHash` (a hash of the explaining cause's message with identifiers, numbers and quoted values removed) and, for code-authored invariant errors, that template as `failureMessage`.
