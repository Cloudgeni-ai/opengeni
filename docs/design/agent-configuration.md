# Agent configuration: persona, capabilities, boundary

Status: proposal for discussion (not implemented).

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
- Workspace `agentInstructions` (the persona) is silently ignored once any
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
| **Persona** | Who is this agent and how does it talk? | OpenGeni's persona |
| **Capabilities** | What can it do? | the preset for the surface |
| **Boundary** | Who shares chats, knowledge, and agent reach? | private chats in a shared tenant workspace |

A **preset** names a coherent combination:

- `workspace-agent`: today's behavior and the stock web app (all capabilities the
  workspace has, OpenGeni persona, workspace-shared chats).
- `assistant`: the embedded default (product tools only plus human input and skill
  reading, embedder persona, private chats).

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
      persona: "You are Acme Analytics' assistant. Answer with numbers first.",
      capabilities: { webSearch: false },
    },
    mcpServers: [{ id: "acme", url: ACME_MCP_URL, headers: userToken(ctx.user) }],
  }),
});
```

Result: the model sees the `acme` tools (visible upfront), `request_human_input`,
and nothing else. The prompt contains the runtime contract modules for those
capabilities, the persona, and nothing about goals, Knowledge, or subagents.

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
| `goals` | `goal_*`, `wait_for_input` | on | off |
| `subagents` | `session_*`, `sessions_list`, `list_models`, `command_*` coordination | on | off |
| `knowledge` | `knowledge_*`, `task_note_*`, instruction-policy tools, docs server | on | off |
| `schedules` | `scheduled_tasks_*` | on | off |
| `artifacts` | `artifacts_*`, `editable_artifact_*`, Sites | on | off |
| `browser` | `interaction__browser_*`, `interaction__computer_*` | on (if available) | off |
| `media` | `generate_image`, `generate_video`, hosted `image_generation` | on (if funded) | off |
| `files` | files server | on | off |
| `workspaceConnectors` | workspace connectors, API Integrations, GitHub, Slack/social/Fiken/Atlassian families | workspace defaults | off (select explicitly via `tools`) |
| `admin` | variable sets, capability/connection setup, machines, rigs, projects | on | off |

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

## Persona and instructions

Three tiers replace today's layers:

| Tier | Contents | Controlled by |
| --- | --- | --- |
| Runtime contract | Mechanics required for tools to work, as per-capability modules | OpenGeni only; composed from resolved capabilities |
| Persona | Identity, tone, writing style, formatting, answer length, domain | default persona ← deployment ← workspace ← session (replace) |
| Instructions and context | session `instructions` (append), `modelContext`, goal snapshot, date | embedder |

Mapping of today's text (sizes in characters):

- Personality, writing style, match-effort, progress updates, final-answer and
  formatting rules (~7.5k): **default persona**. Rendering rules that depend on
  the OpenGeni timeline (`sandbox:` and `artifact:` links, visuals) become the
  `artifacts`/sandbox modules because a product UI may not render them.
- Rules for getting work done, file editing, autonomy, destructive actions (~7k):
  **sandbox module**.
- Using skills (~1k): **skills module**. Integration setup (~1k): **admin module**.
- Session coordination (~6.9k): split into **subagents** (children, waits) and
  **sandbox** (yielded commands).
- CORE goal loop (~0.5k): **goals module**. Knowledge doctrine and storage rules
  (~5.4k): **knowledge module**. Variable set, rig, codemode, code search, and git
  directives are already conditional and become modules as-is.
- Workspace governance (company profile, charter, policies) stays an organization
  feature composed after the persona; it no longer disables the persona.

There is no "replace everything" option: persona replacement covers branding and
voice without breaking tool mechanics.

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

## Core changes

| Area | Change | Size | Migration |
| --- | --- | --- | --- |
| Contracts | `AgentConfig` (`preset`, `persona`, `capabilities`), `SessionAgentProjection`, preview request/response; capability ids and group membership of every first-party tool name | M | no |
| Capability registry | New module (runtime/contracts): per capability its tool matchers, prompt module id, defaults per preset, dependencies, availability probe | M | no |
| Session create (`packages/core/src/domain/sessions.ts`, `session-tool-policy.ts`) | Resolve `agent` + legacy fields into one frozen resolution; child narrowing; caps; 422s | M | rolling: `sessions.agent_config` jsonb (null = legacy resolution) |
| Worker tool assembly (`tool-policy.ts`, `tool-environment.ts`, `skill-tools.ts`, `agent-build.ts`, runtime hosted tools, `xai-subscription`) | Filter every tool family through the frozen resolution; remove the implicit base set; router only when something is deferred | L | no |
| First-party MCP (`apps/api/src/mcp/server.ts`) | Register by capability group; `opengeni` server attached only when a first-party capability is on | M | no |
| Prompt (`operational-instructions.ts`, `coreInstructions`, `inspectPersistentAgentInstructions`) | Split into persona + modules; compose from resolution; session persona tier; governance no longer drops persona | L | rolling: `sessions.persona` text (or inside `agent_config`) |
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

1. **Capabilities for tools** (registry, `agent.capabilities`, resolution, worker
   filtering, preview, `session.agent`). Ships the exact tool set and visibility.
2. **Modular prompt** behind the same resolution; `assistant` preset first,
   `workspace-agent` after eval parity.
3. **Persona tier and boundary presets** (session persona, governance fix, `chats`
   option, org private-session onboarding, `memoryScope` deprecation).
4. **Web app** on the same object; workspace default agent and caps.
5. **Inline tools** as another capability source (separate design).

## Decisions needed

1. Presets: only `workspace-agent` and `assistant`, or also user-defined named
   presets stored per workspace? Recommendation: two built-ins now; named
   workspace presets later.
2. Default boundary for embedders: `private`? Recommendation: yes.
3. Should `list_models` belong to `subagents`? Recommendation: yes.
4. Default persona for `assistant`: neutral product-agnostic voice, not
   "OpenGeni". Recommendation: yes.
5. Persona per session allowed? Recommendation: yes (session wins).
