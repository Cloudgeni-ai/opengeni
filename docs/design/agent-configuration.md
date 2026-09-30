# Agent configuration: identity, capabilities, boundary

Status: capability contracts, persistence, resolution and turn-time enforcement
(M0–M3) implemented. Prompt modularization, preview and boundary presets below
remain proposals; the shipped request uses `capabilities: "all" | "none" | { from, ...toggles }`,
not named presets.

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

An agent is three decisions. Everything else is derived.

| Decision | Question it answers | Default |
| --- | --- | --- |
| **Identity** | Who is this agent (name, product, voice)? | OpenGeni's identity |
| **Capabilities** | What can it do? | the preset for the surface |
| **Boundary** | Who shares chats, knowledge, and agent reach? | private chats in a shared tenant workspace |

A **preset** names a coherent combination:

- `workspace-agent`: today's behavior and the stock web app (all capabilities the
  workspace has, OpenGeni identity, OpenGeni renderer, workspace-shared chats).
- `assistant`: the embedded default (product tools only plus human input and skill
  reading, embedder identity, private chats).

Presets never hide anything: the resolved configuration is always inspectable.

## What users write (SDK)

### Embedded read-only assistant

```ts
export const { GET, POST } = createSessionProxyRoute(og, {
  resolve: async (req) => {
    const me = await auth(req);
    return me ? { tenant: me.orgId, user: me.id } : new Response(null, { status: 401 });
  },
  boundary: { chats: "private" },               // default; "shared" | "isolated"
  createSession: (input, ctx) => ({
    ...input,
    agent: {
      preset: "assistant",
      identity: "You are Acme Analytics' assistant. Friendly and brief.",
      instructions: "Lead with the number, then one sentence of context.",
      renderer: "opengeni", // OpenGeniChat or SessionConversation; "markdown" for a custom UI
      capabilities: { webSearch: false },
    },
    mcpServers: [{ id: "acme", url: ACME_MCP_URL, headers: userToken(ctx.user) }],
  }),
});
```

Result: the model sees the `acme` tools (visible upfront), `request_human_input`,
and nothing else. The prompt contains the runtime contract modules for those
capabilities, base behavior, the embedder's identity and instructions, and
nothing about goals, Knowledge, subagents, or repositories.

### Embedded background agent with writes

```ts
await og.createScheduledTask(workspaceId, {
  name: "Weekly digest",
  schedule: { type: "calendar", cron: "0 8 * * MON", timeZone: "Europe/Oslo" },
  agentConfig: {
    prompt: "Summarize last week's bookmarks and save the digest.",
    agent: { preset: "assistant", capabilities: { goals: true } },
    tools: [{ kind: "mcp", id: "linkding-api" }],   // API Integration, write tools auto-approved at install
    approvalTimeoutSeconds: 3600,
  },
});
```

### Our web app

A new session sends nothing (workspace default, normally `workspace-agent`). The
composer's tool picker edits `agent.capabilities`; workspace settings edit the
workspace's default agent and caps. Same object, same semantics.

### Agent-created child

Omitted `agent` inherits the parent's resolved configuration. An explicit value
may only narrow it (fewer capabilities, same or tighter boundary).

### Preview

```ts
const preview = await og.previewAgent(workspaceId, createRequest);
// { capabilities: {...resolved}, tools: [{ name, capability, visibility: "upfront" | "search" }],
//   prompt: { sections: [{ id, source, chars }], text }, boundary: {...} }
```

The same projection is returned on the session (`session.agent`) so an operator
can answer "what could this agent do" after the fact. The web app's existing
model-context inspector becomes a view over this projection.

## Capabilities

Rules:

1. **Derived tools follow automatically and cannot be toggled.**
   Sandbox attached ⇒ `exec_command`, `write_stdin`, `apply_patch`, `view_image`,
   and `code_search` when the deployment and workspace offer it. Any Skill
   available ⇒ `skill_read`. Anything deferred ⇒ the search router. A product MCP
   server attached ⇒ selected (upfront by default).
2. **Selectable capabilities** (each owns its tools *and* its prompt module):

| Capability | Tools | `workspace-agent` | `assistant` |
| --- | --- | --- | --- |
| `humanInput` | `request_human_input` | on | on |
| `webSearch` | hosted `web_search` (+ `x_search` on SuperGrok) | on | off |
| `skills` | `"read"`: `skill_read`; `"manage"`: + `skill_search/save/install/remove/checkout/publish` | manage | read |
| `goals` | `goal_*` (`wait_for_input` is an unconditional runtime mechanic) | on | off |
| `subagents` | `session_*`, `sessions_list`, `list_models` (`command_read/wait` are runtime mechanics) | on | off |
| `knowledge` | `knowledge_*`, `task_note_*`, instruction-policy tools, docs server | on | off |
| `schedules` | `scheduled_tasks_*` | on | off |
| `artifacts` | `artifacts_*`, `editable_artifact_*`, Sites | on | off |
| `browser` | `interaction__browser_*`, `interaction__computer_*` | on (if available) | off |
| `media` | `generate_image`, `generate_video`, hosted `image_generation` | on (if funded) | off |
| `workspaceFiles` | files server | on | off |
| `workspaceConnectors` | workspace connectors, API Integrations, GitHub, Slack/social/Fiken/Atlassian families | workspace defaults | off (select explicitly via `tools`) |
| `workspaceAdmin` | variable sets, capability/connection setup, machines, rigs, projects | on | off |

3. **Omitted ⇒ workspace default preset. Explicit ⇒ preset + overrides, and
   nothing is added beyond derived tools.**
4. **Narrowing only:** deployment allowlist ⊇ workspace caps ⊇ session ⊇ child.
   A request for a capability above a cap is a 422 naming the cap.
5. **Authority stays separate from visibility.** `firstPartyMcpPermissions` still
   bounds what first-party tools may do; approvals (`requireApproval`, connector
   allow/ask/block, `autoApprovedTools`) still gate individual calls.
6. **Legacy fields keep working** (compatibility policy: additive within a major).
   `firstPartyMcpTools`, `tools`, `excludedMcpServerIds`, `bundledSkillIds` become
   refinements inside the resolved capabilities; when `agent` is omitted, resolution
   reproduces today's behavior exactly.

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

Two additions the current text lacks:

1. **Precedence.** One explicit rule: product, workspace, and session
   instructions override base-behavior defaults (for example "answer in one
   sentence"), never runtime mechanics or safety. Today nothing states this, so an
   embedder's style instruction competes with ours.
2. **Renderer.** `sandbox:` and `artifact:` links only render in OpenGeni's React
   timeline. The session declares its client renderer (`opengeni` or `markdown`);
   with `markdown`, link-syntax rules and inline visuals are omitted and the agent
   uses ordinary Markdown links. This is the only behavior option.

Resulting tiers:

| Tier | Controlled by |
| --- | --- |
| Identity | OpenGeni default, then deployment, workspace, session (each replaces) |
| Base behavior and runtime mechanics | OpenGeni, always on |
| Capability modules | derived from resolved capabilities and attached resources |
| Instructions and context | session `instructions` (append, with precedence over base behavior), `modelContext`, goal snapshot, date |

Workspace governance (company profile, charter, policies) stays an organization
feature composed after identity; it no longer disables the workspace identity
(today `agentInstructions` is dropped whenever a policy is active). There is no
"replace everything" option.

## Boundary

One option on the proxy, chat handler, and session create:

| `chats` | Workspace per | Human visibility | Agent reach (`agentAccess`) | Personal Knowledge |
| --- | --- | --- | --- | --- |
| `private` (default) | tenant | `user_private` | `session` | acting user |
| `shared` | tenant | `workspace_shared` | `workspace` | acting user + workspace |
| `isolated` | end user | `user_private` | `session` | acting user |

- `private` requires the organization private-session setting; the SDK enables it
  during onboarding (organization key, idempotent) instead of failing later.
- `memoryScope` is deprecated: it becomes derived from the boundary and stops being
  documented as "memory".
- Scheduled and webhook-triggered runs are service runs: no personal Knowledge or
  personal connections, workspace tools only.
- Our web app uses the same concepts: organization = customer, workspace = team,
  "Only me" = `private`.

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
- **Goals imply the goals capability.** A goal-bearing session today requires the
  goal tools; with capabilities, setting a goal enables `goals`, and a request
  that disables `goals` while setting a goal is a 422.
- **Preview has two levels.** Before a session runs, preview can resolve
  capabilities, our own tools, tool families per MCP server, and the composed
  prompt (pure composition from `packages/runtime`). The exact tool list of an
  external MCP server exists only after connecting; that stays in the post-run
  model-context inspector (`GET .../sessions/:id/model-context`), whose section
  splitter must learn the module ids.
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
- **There is no prompt-quality eval today.** `operational-instructions.test.ts`
  asserts content, not behavior. A behavior eval (fixed scenarios scored before
  and after) is a prerequisite for changing the default web-app prompt.

## Core changes

| Area | Change | Size | Migration |
| --- | --- | --- | --- |
| Contracts | `AgentConfig` (`preset`, `identity`, `instructions`, `capabilities`, `renderer`), `SessionAgentProjection`, preview request/response; capability ids and group membership of every first-party tool name | M | no |
| Capability registry | New module (runtime/contracts): per capability its tool matchers, prompt module id, defaults per preset, dependencies, availability probe | M | no |
| Session create (`packages/core/src/domain/sessions.ts`, `session-tool-policy.ts`) | Resolve `agent` + legacy fields into one frozen resolution; child narrowing; caps; 422s | M | rolling: `sessions.agent_config` jsonb (null = legacy resolution) |
| Worker tool assembly (`tool-policy.ts`, `tool-environment.ts`, `skill-tools.ts`, `agent-build.ts`, runtime hosted tools, `xai-subscription`) | Filter every tool family through the frozen resolution; remove the implicit base set; router only when something is deferred | L | no |
| First-party MCP (`apps/api/src/mcp/server.ts`) | Register by capability group; `opengeni` server attached only when a first-party capability is on | M | no |
| Prompt (`operational-instructions.ts`, `coreInstructions`, `inspectPersistentAgentInstructions`) | Split into identity, base behavior, runtime mechanics, and capability modules; precedence rule; renderer option; session identity tier; governance no longer drops identity | L | inside `agent_config` |
| Scheduled tasks | `agentConfig.agent` frozen at save; same resolution at run | S | no (jsonb) |
| Workspace settings | default agent + caps; replaces `agentHumanInputEnabled`/`sessionToolDefaults` over time | M | settings jsonb |
| Boundary | proxy/chat option; onboarding enables org private sessions; `memoryScope` derived | M | no |
| Preview + projection | `POST /v1/workspaces/:ws/agent/preview`; `session.agent` | M | no |
| Web app | composer capabilities picker; workspace default agent; inspector over projection | M | no |
| Docs, skill, AGENTS.md | new model; revise the "base runtime tools" invariant and mandatory `opengeni` server note | S | no |

Stability: sessions created before the change keep `agent_config = null` and the
byte-identical legacy composition, so running sessions, recovery, and prompt
caches are unaffected; only new sessions use the new composer. The quality risk is
the prompt split: every module move must be measured with the eval harness before
the `workspace-agent` preset switches to the modular composer.

## Phases

0. **Behavior eval** for the current prompt (baseline scores on fixed scenarios).
1. **Capabilities for tools** (registry, `agent.capabilities`, resolution, worker
   filtering, preview, `session.agent`), workers first, API admission behind a
   switch. Ships the exact tool set and visibility.
2. **Modular prompt** behind the same resolution; `assistant` preset first,
   `workspace-agent` after eval parity.
3. **Identity tier and boundary presets** (session identity, governance fix, `chats`
   option, org private-session onboarding, `memoryScope` deprecation).
4. **Web app** on the same object; workspace default agent and caps.
5. **Inline tools** as another capability source (separate design).

## Decisions needed

1. Presets: only `workspace-agent` and `assistant`, or also user-defined named
   presets stored per workspace? Recommendation: two built-ins now; named
   workspace presets later.
2. Default boundary for embedders: `private`? Recommendation: yes.
3. Should `list_models` belong to `subagents`? Recommendation: yes.
4. Default identity for `assistant`: neutral product-agnostic voice, not
   "OpenGeni". Recommendation: yes.
5. Identity per session allowed? Recommendation: yes (session wins).
6. Renderer default for embedders: `opengeni` when using the React components,
   `markdown` for the chat facade. Recommendation: derive it from the SDK surface
   instead of asking the embedder.
