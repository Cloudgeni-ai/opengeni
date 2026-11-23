# opengeni

## 6.37.2

### Patch Changes

- Updated dependencies [c78d62c]
  - @opengeni/contracts@6.37.2

## 6.37.1

### Patch Changes

- @opengeni/contracts@6.37.1

## 6.37.0

### Patch Changes

- Updated dependencies [c778f4a]
- Updated dependencies [9eee30c]
- Updated dependencies [a2ad192]
- Updated dependencies [36f5f96]
- Updated dependencies [cf218c3]
- Updated dependencies [9f7efdb]
- Updated dependencies [a0b9135]
  - @opengeni/contracts@6.37.0

## 6.36.0

### Patch Changes

- 837e58f: `opengeni connect --client all` sets up only the coding agents installed on this computer, like running it without `--client`, and lists the others as skipped. Naming a client (`--client codex`) still sets it up when it isn't detected; to set up every client regardless, name them all (`--client claude,codex,cursor,vscode`). Mixing `all` with names is rejected.
- 53320fa: `opengeni connect` lists the new Opengeni MCP tools for sharing what an agent built: `app_save` (create an app, save a version or roll back), `app_publish` (who can open it) and `file_save` (share a file and get its link).
- f2c07c2: The ready-made Triage agent suggests a Slack trigger (a new message in a channel), and Triage and Bug fixer start with what they can reach and hand off by name instead of asking for setup first. `scheduled_tasks_create` takes `agentConfig.agentName` (an agent's name or id), and the apps Skill tells agents to start work on new app records with an automation on app change events, not page code. Adding a GitHub event source without a GitHub connection offers Connect GitHub. The coding-agent setup guide shows how to add the Opengeni MCP server by hand when the `opengeni` npm package isn't available.
- Updated dependencies [f2c07c2]
- Updated dependencies [8ace4d4]
- Updated dependencies [27832fd]
- Updated dependencies [23e52db]
- Updated dependencies [27832fd]
- Updated dependencies [59235cb]
- Updated dependencies [b1abd39]
- Updated dependencies [837e58f]
- Updated dependencies [4e1a07f]
- Updated dependencies [55539f1]
- Updated dependencies [66fc51d]
- Updated dependencies [db606a9]
- Updated dependencies [27832fd]
- Updated dependencies [f2c07c2]
- Updated dependencies [b1abd39]
- Updated dependencies [837e58f]
- Updated dependencies [188cef1]
- Updated dependencies [267e190]
- Updated dependencies [b7b28cf]
- Updated dependencies [684587a]
  - @opengeni/contracts@6.36.0

## 6.35.0

### Minor Changes

- fa938cd: `npx opengeni connect` adds the Opengeni MCP server and a short `opengeni` skill to Claude Code, Codex, Cursor and VS Code with Copilot. The organization MCP server lists named tools for connected agents (`delegate`, `wait_for`, session, app, tool, Skill and Knowledge tools). `updateOrganizationMcpConnection` accepts `appDataAccess` and `defaultWorkspaceId`, and `access` is now optional.

### Patch Changes

- Updated dependencies [5fe41ba]
- Updated dependencies [7eda7f0]
- Updated dependencies [7eda7f0]
- Updated dependencies [fa938cd]
- Updated dependencies [74f4771]
- Updated dependencies [8bf1ec2]
  - @opengeni/contracts@6.35.0

## 6.34.0

### Patch Changes

- Updated dependencies [9a84b63]
- Updated dependencies [e292b4a]
  - @opengeni/contracts@6.34.0

## 6.33.0

### Patch Changes

- Updated dependencies [03d58fd]
- Updated dependencies [3091618]
- Updated dependencies [0d394ec]
- Updated dependencies [a204fd7]
  - @opengeni/contracts@6.33.0

## 6.32.0

### Minor Changes

- afb7be7: Console agents follow-ups. `CreateSessionRequest.agent` is widened to an agent configuration object, an organization agent key or id (string), or `{ ref, ... }`: code that reads it must narrow it first (`sessionAgentFieldNamesOrgAgent`). `asUser` `displayName`/`email` need a server with this release; older servers ignore them. `agents:manage` and `tool_credentials:write` are held only by full organization keys or keys that list them, never by `workspace:admin` alone (including the Developer setup preset). Organization compute reaches the Console test workspace only with `allowManagedWorkspaces` (now optional in `OrganizationComputeReach`, read as false). Agent sessions report `costMicros`. Storing a tool login for a workspace the product doesn't manage answers 422. Console audit event actions and workspace sources accept values unknown to the reader. CLI: a missing instructions `.md` file is an error, and `agents deploy --dry-run` prints the diff against the published version.
- afb7be7: Console reads whether organization agents are on from `GET /v1/organizations/:id/console/access` (`orgAgentsEnabled`), so an organization without them makes no failing agent requests. `Session.orgAgent` carries the agent's `name`, and the chat header shows it. Console test chats no longer count toward an agent's chats, usage and cost, or appear in the Console Sessions list. CLI: `agents deploy --dry-run` reports `would create vN` or `unchanged vN`.
- afb7be7: Marking or unmarking a product-managed workspace now needs an account-level context (migration 1512): Console, a workspace an organization API key creates and the Console test workspace still do it, but runtime code acting inside a workspace can't, since the mark decides organization machine and Sandbox Environment reach, organization agents and stored end-user logins. In the reach dialog, a machine's "All workspaces" and "All product-managed workspaces" options say they include the Console test workspace, where Editors run test chats. `WorkspaceReachFields` takes an optional `allDescription`.
- afb7be7: Organization agent Runs on is checked where a chat finally lands: a Personal (Only me) machine is refused whether the request names it, a default would pick it or a worker would join its parent's box on it, a person's own default machine is not used for organization agent chats, and a machine the caller can't read is refused as unavailable. A version now keeps the id of the machine or Sandbox Environment its `runsOn` named when it was saved (migration 1512 adds `agent_revisions.runs_on_target`), so renaming one, or adding another with the same name, no longer moves or breaks the agent; the written name stays for display and YAML. The reach dialog's "All product-managed workspaces" option says that every end customer's chats share the machine. Clients that predate `allowManagedWorkspaces` keep it unchanged when they narrow a machine's or environment's workspaces, so turn it off in Console or with a current SDK.
- afb7be7: Console agents can say where their chats run with `runsOn`: no computer (`none`), each chat in its own cloud sandbox, optionally from an organization Sandbox Environment (`sandbox`), or one organization machine shared by every chat (`machine`). Omitted keeps today's placement. Saving or deploying refuses machines and environments that are not the organization's (Personal machines included), chat creation checks that the machine or environment is available in the chat's workspace, and a request's own `sandboxBackend`, `targetSandboxId` or `rigId` still wins within the usual checks and is recorded as the `runsOn` override; a Personal machine is never used for an organization agent chat. Organization machines and Sandbox Environments get an "All product-managed workspaces" reach option (`allowManagedWorkspaces`) that covers every workspace the organization's product manages, including ones created later. Console's agent editor has a "Runs on" setting and the reach picker the new option; `GET /v1/organizations/:organizationId/agents/compute` and the SDK's `listOrganizationAgentCompute` list the choices. The agent file JSON Schema includes `runsOn`.

### Patch Changes

- afb7be7: `opengeni agents export <key>` reads the agent by key, so it works against the real API. `opengeni agents deploy` recognises an agent managed in Console (the API's `details.code`), prints the clear message, and its `--json` output reports `code: "agent_managed_in_console"` and the HTTP `status` for each failed agent.

  End-user `displayName` and `email` are lenient: `null` or a non-string value is ignored instead of rejecting the request, and the latest value sent wins on every API replica.

  In the SDK, `CreateSessionRequest.agent` is now `AgentConfigRequest | OrgAgentRef | OrgAgentSessionRequest`. TypeScript that reads inline fields such as `req.agent.capabilities` must narrow first; the new `isOrgAgentRef(agent)` guard does that.

- afb7be7: Console agents as code: `opengeni agents deploy <dir>` deploys `agents/<key>.yaml` files to an organization (`--dry-run`, `--publish`, `--move-running-chats`, `--json`) and `opengeni agents export <key>` writes one back; the package ships the agent file JSON Schema (`schemas/agent.schema.json`). The SDK adds `@opengeni/sdk/organization-agents` (`organizationAgents()`, `defineAgent()`, end-user tool logins), accepts an organization agent in session create (`agent: "<key>"` or `{ ref, ... }`, `agentOverrides`) and reads `Session.orgAgent`. The session proxy drops an organization agent sent by the browser; name it in `createSession`.
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [afb7be7]
- Updated dependencies [01663b4]
  - @opengeni/contracts@6.32.0

## 6.31.1

## 6.31.0

### Patch Changes

- 3866b75: New `opengeni` command-line package. `opengeni --version` and `opengeni --help` work; `opengeni agents deploy` is reserved and, in this version, says it is not available yet and exits with code 2.
