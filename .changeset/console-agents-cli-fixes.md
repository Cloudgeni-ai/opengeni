---
"opengeni": patch
"@opengeni/sdk": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
---

`opengeni agents export <key>` reads the agent by key, so it works against the real API. `opengeni agents deploy` recognises an agent managed in Console (the API's `details.code`), prints the clear message, and its `--json` output reports `code: "agent_managed_in_console"` and the HTTP `status` for each failed agent.

End-user `displayName` and `email` are lenient: `null` or a non-string value is ignored instead of rejecting the request, and the latest value sent wins on every API replica.

In the SDK, `CreateSessionRequest.agent` is now `AgentConfigRequest | OrgAgentRef | OrgAgentSessionRequest`. TypeScript that reads inline fields such as `req.agent.capabilities` must narrow first; the new `isOrgAgentRef(agent)` guard does that.
