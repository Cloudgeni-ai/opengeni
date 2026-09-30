# Agent configuration: identity, capabilities, boundary

Status: implemented (PR #3000). This records the shipped model, its
enforcement, and what changed from the original proposal.

### Implemented turn-time boundary (M3)

`resolveAgentToolFamilies` in `packages/contracts/src/agent-config.ts` is the
shared gate for configured sessions. Worker preparation filters Skill tools,
model listing, first-party selections and built-in files/docs servers; runtime
construction filters human input, hosted search and image/video tools. SuperGrok
request authorization also gates both injected `web_search` and `x_search`.
Deployment unavailability remains off even when legacy columns retain tools.
Null `agent_config` keeps the historical attachment and request paths unchanged.

`skills: "read"` exposes **only** `skill_read`, and only with a nonempty configured
catalog; `"manage"` exposes all seven tools, and `false` exposes none. Sandbox
tools remain resource-derived. `wait_for_input`, `command_read` and `command_wait`
remain runtime mechanics even with an explicitly empty first-party selection.
Titling does not require selecting `set_session_title`; existing provider route
and session-control permission restrictions still apply.

The search router is attached only for actually deferred tools on configured
sessions. A durable router call/output, including inactive compacted history,
keeps it attached on later turns without restoring revoked tools. The Codemode
SDK proxy checks both capability-derived permissions and endpoint families:
permissions shared across capabilities cannot re-enable disabled operations.

Configured turns complete deferred catalog preparation before deciding whether
the router is needed, so an empty MCP catalog does not advertise a search
surface. Legacy turns retain their overlapping preparation path. Once used,
the router survives a later deployment search-switch change. Minimal product
MCP refs default upfront; an explicit `eager: false` still requests search
visibility, and `"all"` retains the creator's exact legacy refs.

Session `effectiveTools` projects known model-facing names and upfront/search
visibility from server-side runtime inputs. External MCP tools remain explicitly
unknown (`toolsKnown: false`) until a catalog is available; they are not invented
from capability names.

Media projection uses `resolveAgentMediaToolSurface`, the runtime's shared
adapter-attachment descriptor. Before the exact turn has selected its image/video
adapters, `mediaToolsKnown: false` means no media tools are claimed in `tools`.
Subscription readiness, model support, workspace keys and media policy do not
prove attachment: delegated text credentials may lack a local media credential
identity. A verified per-session attachment snapshot reports the actual hosted or
adapter names. Explicitly disabled or resolved-absent media is known empty.
The capability bit expresses authorization, not availability; unresolved media
is not falsely added to `unavailable`.

## Why

An embedder today configures an OpenGeni agent through about fifteen independent
knobs spread over the session request, workspace settings, and deployment env:
`tools`, `excludedMcpServerIds`, `mcpServers`, `firstPartyMcpTools`,
`firstPartyMcpPermissions`, `bundledSkillIds`, `skills`, `sandboxBackend`,
`instructions`, workspace `agentInstructions`, `visibility`, `agentAccess`,
`memoryScope`, `agentLearning`, `sessionToolDefaults`, `agentHumanInputEnabled`,
`codeSearchEnabled`, plus eight `OPENGENI_*` tool flags. Coding-agent integration
evals (Sonnet in Umami, the Vercel chatbot, and linkding; Luna in OpenGeni staging)
showed the consequences:

- No request field yields an exact tool set. Skill writers (`skill_save`,
  `skill_install`, `skill_publish`, `skill_remove`, `skill_checkout`,
  `skill_search`) and `list_models` have no gate; hosted web search is per
  model/deployment only; `tools: []` still attaches the `opengeni` server. One
  eval agent executed `skill_save` inside a read-only analytics assistant.
- Nobody can see the effective tool set or prompt; agents asked the model.
- About 9k tokens of fixed system text (the operational contract in
  `packages/runtime/src/operational-instructions.ts` plus CORE in
  `packages/runtime/src/index.ts`) describe goals, Knowledge, subagents, Sites,
  artifacts, and Connected Machines whether or not the session has them.
- Workspace `agentInstructions` (the white-label identity) is silently ignored once any
  instruction policy is active (`governance-model.ts` →
  `structuredWorkspacePolicyActive` → `agent-build.ts`).
- `memoryScope` / chat-facade `memory` are mostly vestigial: the Knowledge MCP
  server receives `sessionMemory` but never reads it (`apps/api/src/app.ts` →
  `buildOpenGeniMcpServer`); it only changes the initial learning-settings scope
  and personal file publication. Personal Knowledge follows the acting user.
- Human privacy (`visibility`), agent reach (`agentAccess`) and Knowledge scope
  are separate knobs; private chats in a shared workspace additionally need the
  organization private-session setting (migration 0323). Eval agents chose one
  workspace per end user to be safe.

## The model

An agent is one object; everything else is derived.

```ts
type AgentConfigRequest = {
  capabilities?: "all" | "none" | ({ from: "all" | "none" } & Partial<Toggles>);
  identity?: string | null; // who the agent is; null = workspace default, then OpenGeni's
  instructions?: string;    // alias of the session `instructions` field
  renderer?: "opengeni" | "markdown";
};
```

`"all"` is everything the workspace offers, which is exactly what a session
without `agent` gets. `"none"` is the session's own tools plus asking questions
and reading Skills. There are no named presets: a starting point plus visible
toggles says the same thing without a vocabulary to learn, and the resolved
configuration is always inspectable (`session.agent`, `session.effectiveTools`).

Chat privacy is not part of the agent. It is the SDK option `chats` on the
session proxy and the chat facade (see [Chats](#chats)).

## What users write (SDK)

### Embedded read-only assistant

```ts
export const { GET, POST } = createSessionProxyRoute(og, {
  chats: "private", // default; "shared" | "isolated"
  resolve: async (req) => {
    const me = await auth(req);
    return me
      ? { workspaceId: me.openGeniWorkspaceId, user: me.id }
      : new Response(null, { status: 401 });
  },
  createSession: async ({ initialMessage, idempotencyKey }, { user }) => ({
    initialMessage,
    idempotencyKey,
    agent: {
      identity: "You are Acme Analytics' assistant. Friendly and brief.",
      instructions: "Lead with the number, then one sentence of context.",
      capabilities: "none",
    },
    mcpServers: [{ id: "acme", url: ACME_MCP_URL, headers: await userHeaders(user) }],
    tools: [{ kind: "mcp", id: "acme" }],
    sandboxBackend: "none",
  }),
});
```

Result: the model sees the `acme` tools (upfront), `request_human_input`,
`skill_read` when Skills exist, and the runtime mechanics. The prompt holds
identity, base behavior, runtime mechanics and the session instructions, and
nothing about goals, Knowledge, subagents or repositories.

### Embedded background agent with writes

```ts
await og.createScheduledTask(workspaceId, {
  name: "Weekly digest",
  schedule: { type: "calendar", hour: 8, minute: 0, daysOfWeek: ["MONDAY"], timeZone: "Europe/Oslo" },
  agentConfig: {
    prompt: "Summarize last week's bookmarks and save the digest.",
    agent: { capabilities: { from: "none", goals: true } },
    tools: [{ kind: "mcp", id: "linkding-api" }],
  },
});
```

The agent is frozen into the schedule's execution digest and resolved once per
accepted occurrence; recovery reuses the accepted resolution.

### Our web app

Settings > General > Agent edits the workspace's `sessionAgentDefaults`
(starting point, capabilities, identity). The composer's + > Capabilities sends
`agent.capabilities` only when "Customize for this chat" is on. The session dock
shows the resolved agent, its tools with up-front/on-demand visibility, and edits
it from the next turn. The schedule form uses the same picker.

### Agent-created child and mid-session changes

Omitted `agent` on a child inherits the parent's resolved configuration; an
explicit value may only narrow it. Children of a session without a configuration
stay legacy. `PUT .../sessions/:id/agent` (`updateSessionAgent`) replaces the
configuration under the tool-policy version (409 when stale), records
`session.agent.updated` and applies from the next turn; a legacy session converts
from its current effective state.

## Capabilities

Rules:

1. **Derived tools follow automatically and cannot be toggled.**
   Sandbox attached ⇒ `exec_command`, `write_stdin`, `apply_patch`, `view_image`,
   and `code_search` when the deployment and workspace offer it. Anything
   deferred ⇒ the search router. A product MCP server attached ⇒ selected
   (upfront by default). Runtime mechanics (`wait_for_input`, `command_read`,
   `command_wait`, titling) are always present.
2. **Selectable capabilities** (each owns its tools and, where it has one, its
   prompt module). The single source of truth is the registry in
   `packages/contracts/src/agent-config.ts`; a test maps every first-party tool.

| Capability | Tools | In `"none"` |
| --- | --- | --- |
| `humanInput` | `request_human_input` | on |
| `webSearch` | hosted `web_search` (+ `x_search` on SuperGrok) | off |
| `skills` | `"read"`: `skill_read` (with a nonempty catalog); `"manage"`: all seven Skill tools | `"read"` |
| `goals` | `goal_*` | off |
| `subagents` | `session_*`, `sessions_list`, `set_other_session_title`, `list_models` | off |
| `knowledge` | `knowledge_*`, `memory_*`, `task_note_*`, instruction-policy, preference and company-profile tools, docs server | off |
| `schedules` | `scheduled_tasks_*`, `scheduled_task_runs_list` | off |
| `artifacts` | `artifacts_*`, `editable_artifact_*`, `sandbox_file_publish`; Sites and visuals guidance | off |
| `browser` | `interaction_*`, `browser_*`, `computer_*` | off |
| `media` | `generate_image`, `generate_video`, hosted `image_generation` | off |
| `workspaceFiles` | files server | off |
| `workspaceConnectors` | workspace default connectors, API Integrations, Drive publishing, GitHub/Slack/social/X/Reddit/Fiken/Atlassian families | off |
| `workspaceAdmin` | variable sets and environments, capability and connector setup, machines, sandboxes, rigs, projects | off |

3. **Omitted ⇒ the workspace default, else `"all"`.** Explicit ⇒ starting point
   plus toggles; nothing is added beyond derived tools.
4. **Narrowing only across the tree:** deployment limits ⊇ session ⊇ child.
   Workspaces set defaults, not caps. A capability the deployment does not offer
   is reported off in `unavailable`; requesting it is a 422.
5. **Authority stays separate from visibility.** `firstPartyMcpPermissions` still
   bounds what first-party tools may do; approvals still gate individual calls.
6. **Legacy fields keep working.** `firstPartyMcpTools`, `tools`,
   `excludedMcpServerIds` and `bundledSkillIds` refine inside the resolved
   capabilities; naming a tool of a capability that is off is a 422
   `agent_config_conflict`. Without `agent`, resolution reproduces the creator's
   legacy values exactly.

## Identity and instructions

The current system text is the operational contract
(`packages/runtime/src/operational-instructions.ts`, ~28.8k chars), CORE
(`coreInstructions()` in `packages/runtime/src/index.ts`, ~5.9k), and the default
template (`DEFAULT_AGENT_INSTRUCTIONS` in `packages/config/src/index.ts`, ~1.4k).
Read in full, it falls into four buckets:

| Bucket | Today's text | End state |
| --- | --- | --- |
| **Identity** | opening line ("You are an agent for the current workspace…"), `# Personality`, the template's first sentence ("You are an OpenGeni workspace agent…"); ~0.6k | Replaceable. The only part an embedder rewrites: name, product, domain, voice. |
| **Base behavior** | writing style (outcome first, minimal formatting, CommonMark); match effort; progress updates (short commentary, skipped under ~20 s; the runtime already separates commentary from the final answer); final-answer rules; autonomy by request type (answer, diagnose, change, monitor), no inferred authorization, stated assumptions, stop for new authority; no unsolicited disclaimers; verification matched to scope | Always on, no knobs. Tuned through instructions, which take explicit precedence (below). |
| **Runtime mechanics** | `wait_for_input` semantics, new messages arriving mid-turn (steer/queue), continuing after compaction, command yields | Always on: every agent on the durable runtime needs them. Moved out of "working with the user" into their own section. |
| **Capability modules** | everything below | Included only when the capability or resource is present. |

Capability modules (current size in characters):

- **sandbox** (any sandbox attached): `rg`, `apply_patch`, shell escaping, temp
  directories, destructive-command safety, `sandbox:` file links (when the client
  renders them), yielded commands (`command_read`, `command_wait`). Most embedded
  agents use the sandbox for arbitrary file and data work, so this is common.
- **repositories** (repository resources or git credentials attached): mount paths
  `repos/<host>/<owner>/<repo>`, pre-authenticated `gh`/`glab`/`az`, focused branch
  and pull request policy, dirty worktree and `git reset`/`checkout` rules, the git
  binding directive. Most embedders never attach repositories.
- **attachments** (files attached): `.opengeni/files/<file-id>/` mounts and
  read-only copies.
- **machines** (Connected Machine target): host-native paths and link examples.
- **artifacts** (artifacts capability and an OpenGeni renderer): document artifact
  delivery via `opengeni-documents`, `artifact:` links and previews, publication,
  Sites and inline visuals (`opengeni-visualize`, `opengeni-sites`), goal
  deliverable evidence (~3.5k).
- **goals**: goal loop from CORE (~0.5k) plus goal-deliverable rules.
- **subagents**: child creation, `session_wait`, `session_events`, supervision and
  receipt correlation (~5k of session coordination).
- **knowledge**: storage-choice rules, instruction-policy editing, Knowledge
  doctrine (~5.4k of CORE).
- **skills** (~1k), **admin** or integration setup (~1k), plus the already
  conditional variable-set, rig, codemode, and code-search directives.

Two additions the legacy text lacked, both shipped in the modular composer
(`packages/runtime/src/agent-instructions/`):

1. **Precedence.** One explicit rule: product, workspace, and session
   instructions override base-behavior defaults (for example "answer in one
   sentence"), never runtime mechanics or safety.
2. **Renderer.** `sandbox:` and `artifact:` links only render in OpenGeni's React
   timeline. The session declares its client renderer (`opengeni` or `markdown`);
   with `markdown`, link-syntax rules and inline visuals are omitted and the agent
   uses ordinary Markdown links. This is the only behavior option. The chat
   facade and Slack tasks default to `markdown`.

Resulting tiers:

| Tier | Controlled by |
| --- | --- |
| Identity | OpenGeni default, then deployment, workspace, session (each replaces) |
| Base behavior and runtime mechanics | OpenGeni, always on |
| Capability modules | derived from resolved capabilities and attached resources |
| Instructions and context | session `instructions` (append, with precedence over base behavior), `modelContext`, goal snapshot, date |

Workspace governance (company profile, charter, policies) stays an organization
feature composed after identity; in the modular composer it no longer disables
the workspace identity (the legacy path still drops `agentInstructions` whenever
a policy is active, byte for byte). There is no "replace everything" option.
The composed layers are identity, operational contract (its modules reported as
`modules: [{ id, chars }]` metadata), codemode/code-search/git bindings, Skill
catalog, workspace governance, workspace memory and session instructions.

## Chats

`chats` is SDK sugar on the session proxy and the chat facade; the server's
privacy semantics are unchanged.

| `chats` | Workspace per | `visibility` | `agentAccess` | `memoryScope` |
| --- | --- | --- | --- | --- |
| `private` (proxy default; facade default with a user) | tenant | `private` | `session` | `user` |
| `shared` | tenant | `workspace` | `workspace` | `workspace` |
| `isolated` | tenant user | `private` | `session` | `user` |

- Explicit create fields still win over the `chats` defaults.
- Private chats need the organization private-session setting. The SDK does not
  enable it; a missing setting raises `OpenGeniSetupError` with owner/admin
  remediation for the API, SDK and web app.
- `isolated` provisions a workspace and external member per tenant user through
  the facade's `workspaceIdFor({ tenant, user }, { isolation: "user" })`
  (`createWorkspaceIdResolver` on `@opengeni/sdk/tenant-workspaces`).
- The facade without a user keeps its legacy defaults (workspace visibility,
  session reach, Knowledge off). With a user its default moved from Knowledge
  off to private chats with personal Knowledge on (changelog).
- Scheduled and webhook-triggered runs are service runs: no personal Knowledge
  or personal connections.

## Nuances that shape the implementation

- **Runtime tools are not capabilities.** Base behavior and runtime mechanics
  depend on first-party tools: `wait_for_input` (resume after background work),
  `command_read`/`command_wait` (yielded commands), and session titling. The
  `opengeni` server therefore stays attached, but with only this runtime set when
  no first-party capability is on. Titling becomes a runtime mechanic (parallel
  title generation already exists), so minimal sessions stop being stuck on
  "New conversation".
- **Tools may change mid-session; prompt modules follow.** Today the tool-policy
  PUT and capability attach change MCP servers and `firstPartyMcpTools` on a
  running session (versioned). Connectors carry no prompt module, so they keep
  changing freely behind tool search without touching the prompt prefix. Toggling a
  platform capability (goals, subagents, knowledge, artifacts) changes the system
  prompt from the next turn: an explicit, rare, user-initiated cache break.
- **Readers before writers.** A narrowed `agent_config` changes execution
  authority. During a rolling deploy an old worker would ignore it and run the
  full tool set. Workers that understand `agent_config` ship first; the API admits
  new `agent` values behind a default-off switch turned on after the old
  generation is gone (the AGENTS.md rule for authority-changing fields).
- **Every session creator maps onto the same resolution:** public API and SDK,
  the session proxy, agent-created children (`session_create`), Slack task
  defaults, automation templates, scheduled tasks (`agentConfig`, including the
  execution digest and access-drift report), composer drafts
  (`new_session_drafts`), site-auth maintenance sessions, and browser sessions.
  Their stored legacy fields keep working.
- **Goals imply the goals capability.** Setting a goal enables `goals`, and a
  request that disables `goals` while setting a goal is a 422.
- **No separate preview API.** Every session reports `agent` and
  `effectiveTools` from creation; the exact tool list of an external MCP server
  exists only after connecting. The exact prompt is in the model-context
  inspector (`GET .../sessions/:id/model-context`); wire captures carry the
  persistent layer sections and module metadata so the inspector can title them.
- **Codemode has two enforcement paths.** Tool calls execute only the attempt's
  frozen catalog. The SDK HTTP proxy additionally gates endpoint families and
  intersects its derived permission ceiling with the live resolved configuration.
- **Workspace-managed Skills and governance are tenant-level.** Admin-installed
  workspace Skills and policies appear in every session of that workspace. That is
  correct for a per-tenant workspace and is documented as part of the boundary.
- **Knowledge scope already follows privacy.** Private tasks author personal
  Knowledge and shared tasks author workspace Knowledge (CORE text and the
  learning-scope derivation in `packages/core/src/domain/sessions.ts`), so
  `memoryScope` adds nothing and is retired as a derived value.
- **Existing white-label templates.** Workspaces whose `agentInstructions`
  replaced the whole default template (including its `{{core}}` marker) are read
  as identity; the marker is ignored. They regain repository and attachment
  guidance, which the replaced template used to drop.
- **Hosted tools are provider-specific.** Disabling web search must remove the
  hosted tool from the Responses request and from the SuperGrok request body
  (`xai-subscription` appends `web_search`/`x_search` itself).
- **Prompt quality is measured.** `bun run eval:behavior`
  (`scripts/agent-behavior-eval/`) scores fixed scenarios for the legacy and
  modular prompts; the modular `"all"` prompt switched on for new sessions only
  after it matched the legacy baseline.

## Rollout

Readers shipped before writers. `OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED`
(default off) admits `agent` on every surface, the workspace default and the
update route; while it is off they return 422 `agent_config_not_enabled` and the
client config reports `agentConfig.enabled: false`, which also hides the web UI.
`OPENGENI_AGENT_CONFIG_DEFAULT_FOR_NEW_SESSIONS` makes omitted `agent` resolve to
`{ from: "all" }` with the modular prompt (the web app's switch). Workers honor a
stored configuration regardless of either switch, and an old worker ignoring an
`"all"` configuration still produces the legacy tool set.

## Dropped from the proposal

- Named presets (`workspace-agent`, `assistant`): replaced by starting points
  and toggles.
- A pre-run preview API: every session reports `agent` and `effectiveTools`.
- Workspace capability caps: deployments are the only hard limits.
- A `boundary` object and automatic private-session enablement: `chats` is an
  SDK option and a missing setting is an actionable setup error.
- Retiring `memoryScope`: it stays a supported create field that `chats` sets.
- Inline host-defined tools: a separate design.
