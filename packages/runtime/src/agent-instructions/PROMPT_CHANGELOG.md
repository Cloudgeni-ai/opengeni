# Modular prompt changelog

Sessions with an agent configuration (`sessions.agent_config` non-null) get their
system instructions from this folder. Sessions without one keep the legacy
composition (`operational-instructions.ts` + the persona template + CORE in
`../index.ts`) byte for byte; `test/agent-instructions/legacy-prompt-lock.test.ts`
pins those bytes.

Both compositions now tell child sessions that final answers reach their parent
automatically, while retaining messages for early updates and other sessions.
The legacy byte locks and worker request hashes include this shared guidance.

The legacy locks also include the shared goal-completion handoff guidance.
All fourteen omitted/null legacy cases retain the same composition and layer
order. Shared guidance is not an intentional removal or modular-only addition.

Both compositions now share one Knowledge guidance source: useful retention is
ordinary work under the accepted learning policy, adopted feedback corrects
existing entries, and relevant retrieval precedes dependent tasks. Task-only
feedback, unaccepted proposals, interim experiment rounds and live status do not
become settled knowledge. The worker also renders accepted modes and Knowledge
scope in governance. These changes preserve destination authority and do not add
permission for external actions or settings changes. New Slack sessions follow
the same policy; old stored Slack session instructions remain unchanged.

Prompt-size review condensed Knowledge guidance from 941 to 317 words (6,686 to
2,372 characters), keeping workflow details in tool descriptions. The accepted
learning block supplies modes/scope without repeating the doctrine. Slack file
guidance appears only when context contains files. Intentional legacy locks and
the independent default-persona fixture are updated with this shared revision.

## Authoring rule

With `capabilities: "all"`, renderer `opengeni`, and every resource present
(managed sandbox, Connected Machine, repositories, Git credentials, attachments,
workspace environment, rig), the modular text says exactly what the legacy
contract, default template, and CORE say, sentence for sentence, except for the
edits listed in the `diff` blocks below. `test/agent-instructions/prompt-legacy-diff.test.ts`
splits both texts into sentences (headings and list markers are layout, not
content) and fails when the difference is not exactly this list. Add an entry
here, with its reason, in the same change as any wording edit.

## Structure

Composition order (each part separated by a blank line):

1. **Identity** (replaceable, about 0.3k): session identity, else workspace
   identity (explicit default, else the legacy `agentInstructions` persona with
   `{{core}}` removed), else a non-default deployment template, else
   `DEFAULT_AGENT_IDENTITY`. Workspace governance never drops it (the legacy
   path drops a workspace persona once an instruction policy has entries).
2. **Operational contract** (one inspector layer; module ids and sizes are
   reported as `modules` metadata):
   - `base_behavior` (always): precedence rule, Personality, Writing style,
     Working with the user, Match effort, Progress updates, Final answer,
     Formatting rules, Rules for getting work done, Autonomy and persistence,
     Destructive Actions.
   - `runtime_mechanics` (always): new messages while working (steer/queue),
     waiting and `wait_for_input`, compaction, and background commands. The
     background-command paragraphs (and the `command_wait` mentions in the
     in-flight examples and `subagents`) appear only when a managed sandbox or
     Connected Machine is attached, because `command_read`/`command_wait` are
     withheld from a turn without compute.
   - Conditional modules, in this order: `renderer_markdown`, `sandbox`,
     `connected_machine`, `repositories`, `workspace_environment`, `rig`,
     `artifacts`, `media`, `goals`, `subagents`, `knowledge`, `skills`, `admin`,
     `attachments` (last because it varies per turn).
3. Attempt directives, unchanged text: Codemode, code search, Git credential
   bindings.
4. Skill index (only when it is not delivered in history).
5. Workspace governance, then the historical memory block.
6. `# Session instructions`, last, headed by one sentence: "These
   instructions were set for this session. Follow them over the default
   behavior above, such as tone, length, and format." It gives the precedence
   rule a concrete target where the instructions are. Added after the first
   modular eval run, where one of three one-sentence runs ignored a session
   style rule at the end of the prompt; with the heading, six of six followed
   it. (Not part of the sentence diff, which composes no session
   instructions.)

Headings that moved or were added (layout only, not diffed):

- The shell, file-editing, and shell-specific destructive rules moved from
  "Rules for getting work done", "File editing constraints", and "Destructive
  Actions" into `# Working in the sandbox` (with `## File editing constraints`,
  `## Destructive commands`, `## File links`).
- The wait, steer, compaction, and command paragraphs moved from "Working with
  the user", "Rules for getting work done", and "Session coordination" into
  `# Runtime mechanics` (with `## New messages while you work`, `## Waiting`,
  `## Compaction`, `## Background commands`).
- Document, publication, Site, and visual rules moved from "Formatting rules"
  and "Visuals in chat" into `# Documents, files, and visuals`.
- Goal lines (CORE and the two goal-pause sentences from Autonomy) moved into
  `# Goals`.
- CORE's storage, instruction-editing, and Knowledge lines became
  `# Knowledge and durable storage`, split into paragraphs.
- The default template's lines moved to their modules: identity, final answer,
  `# Working in the sandbox`, `# Repositories and Git`, `# Attached files`,
  `# Using skills`.
- CORE's environment and rig blocks became `# Workspace environment` and
  `# Sandbox environment`.

## Sentence edits (modular "all" vs legacy)

Tool discovery and media. Deferred schemas must remain behind the existing
search router, while modular agents need to distinguish missing disclosure
from missing execution authority. Runtime mechanics explains ranked discovery
and literal-prefix recovery; the new `media` capability module directs image
and video requests to runtime/provider tools rather than integration setup.
Disabled media removes that module. The legacy prompt remains unchanged.

```diff
+ Deferred tool schemas are omitted from the first request; absence there does not prove a tool is unavailable.
+ When deferred tools are attached, use `tool_search` for one focused capability at a time; broad searches with small limits can omit a relevant tool.
+ If a search misses, use `tool_list` and follow `nextCursor` until the relevant authorized names are covered, then load exact names with `tool_search`.
+ `namePrefix` is a literal tool-name prefix, not a capability keyword; an empty filtered page does not prove the capability is unavailable.
+ Discovery never grants authority, and remembered tool names must still resolve against the current authorized catalog.
+ Use an attached image-generation tool when the user requests generated images or edits.
+ If it is deferred, use a focused image-generation query with `tool_search`, or request the exact `generate_image` name before concluding no image tool exists.
+ `generate_image` is a runtime tool; integration catalogs and sandbox CLI lists do not enumerate it.
+ A hosted `image_generation` tool may instead be visible directly on supported provider routes.
+ The media capability permits discovery, but does not prove a provider adapter is attached; establish availability from the current authorized tool catalog.
+ Use the returned tool schema for references and output controls; do not invent model names or provider-specific options.
+ For video, discover `get_video_generation_capabilities` and `generate_video`, read current capabilities before selecting a model, and follow the available video-generation Skill.
```

Identity. The legacy text opened with two identity statements (the contract's
generic line and the template's OpenGeni line). The default identity keeps the
more specific one and adds the contract's collaboration and voice sentences,
so replacing the identity replaces all of them together.

```diff
- You are an agent for the current workspace.
```

Precedence. New: embedder instructions must beat OpenGeni's style defaults
without being able to switch off the runtime or safety rules.

```diff
+ Product, workspace, and session instructions take precedence over the default behavior described here, such as tone, length, and format.
+ They never override the runtime mechanics or the rules on authorization and destructive actions.
```

Connected Machine. The machine-specific link bullets now stand in their own
module, which needs one sentence saying what a Connected Machine is (the legacy
text named it only inside link examples).

```diff
+ This session runs on a Connected Machine, a computer its owner connected to this workspace.
+ You work directly on its real filesystem, so treat existing files and processes as the owner's.
```

Goal completion. In the first modular-none eval runs, two of nine goal runs
verified the work, said the goal was complete, and ended without calling the
(deferred) goal tool. The goal module now says so explicitly.

```diff
+ Saying or verifying that the work is done does not complete the goal: call opengeni__goal_complete, and search for the goal tools first when they are not listed.
```

## Conditional variants (capability or resource absent)

These sentences replace or drop a legacy sentence only when the named
capability or resource is off; with everything on, the legacy sentence is used
unchanged.

- `artifacts` off: "Reserve audits, second sources, and extra verification for
  requests that need them, …" (no documents, Sites, visuals); "First check
  whether an available tool already provides the capability natively." (no Site
  example).
- `goals` off: in-flight answers drop ", even when a goal is active"; "If nothing
  is in flight, the answer is your final response; offer to continue when work
  remains."; child integration drops "completing a goal"; the `goal.completed`
  sentence and the goal document-deliverable bullet are omitted.
- `subagents` off: in-flight examples read "(a command or a timed recheck)";
  Integration setup drops "(see Session coordination)".
- `workspaceAdmin` off: the child Variable Set sentence and the rig
  `rig_propose_change`/`rig_get` sentences are omitted.
- Managed sandbox only: "Use the active workspace path exactly as exposed to
  you. Managed sandboxes normally use `/workspace`."
- Connected Machine only: "… A Connected Machine uses its host-native workspace
  root, such as `/home/u/proj` or `C:/repo`, and that root is valid inside a
  `sandbox:` link."; the `/tmp` link rule and the pre-authenticated provider
  CLI sentence are omitted (the machine owns its files and Git auth), and the
  repository mount sentence is omitted (no platform clones).
- Renderer `markdown`: the File links section, the Connected Machine link
  examples, "Source-code navigation may still use workspace file links.",
  "Inline HTML stays in chat unless explicitly saved as a Site.", and Visuals
  in chat are omitted; `renderer_markdown` adds "# Links and rendering"
  (plain web links only; workspace files by path in backticks when a sandbox
  is attached).

## Tool-availability variants (OPE-725)

A broad capability is product semantics, not tool authority: a configured
session can keep `goals` or `knowledge` on while its accepted first-party
selection or permission ceiling excludes the matching tools. The worker now
freezes a per-attempt `AgentPromptToolAvailability` from the same selection and
ceiling it signs into the delegated token (`deriveAgentPromptToolAvailability`,
using the shared first-party registration table). It is a rendering input only
and never changes capabilities, catalogs, approvals, or permissions.

Only a first-party tool that the selection omits, or whose registration
predicate the ceiling cannot satisfy, is proven absent. Deferred or lazily
disclosed tools, external MCP catalogs, provider-hosted and local adapter tools
(`tool_search`, `generate_image`, `command_input`, ...) and live-grant narrowing
are unknown and keep their guidance. Omitted availability (legacy sessions,
old callers, standalone compaction) renders exactly as before; the legacy
composition never reads it. With nothing proven absent the modular bytes are
unchanged, including for the default selection and ceiling.

When a named tool is proven absent, only the clauses naming it change:

- Goals: the ownership sentence names only the remaining goal tools (with
  none: "If the session has a goal, you own it: keep working toward it.");
  the goal_complete handoff and call sentences need `goal_complete`, and
  without it: "Saying or verifying that the work is done does not complete the
  goal, and this session has no goal-completion tool: report the outcome
  instead of claiming the goal is complete."; the goal-pause judgment needs
  `goal_pause`; the document-deliverable bullet needs `goal_complete` and
  `goal_set` or `goal_progress`.
- Knowledge: each sentence naming `task_note_save`, `knowledge_search`,
  `knowledge_get`, `knowledge_save`, `knowledge_prepare_save`,
  `knowledge_retain_message`, `knowledge_retain_file`, `instruction_policy_get`
  or `instruction_policy_save` is narrowed or dropped; the "Before saving"
  paragraph and "Save a separate finding" need `knowledge_save`. Storage
  purpose, grounding, pending-entry, learning-mode, and authority rules stay.
- Integration setup: the `variable_set_list`/`capability_catalog_search`
  discovery sentence names what remains; the two setup-card sentences and the
  card follow-ups need their tools.
- Session coordination: the `session_events` paragraph, the
  `session_send_message` follow-up clause, the child Variable Set sentence
  (`variable_set_list`, `session_create`), the `wait_for_input` long-wait and
  `finalAnswer` sentences, the `session_wait` join and short-wait sentences,
  and the `session_get` contrasts each need their tools.
- Runtime mechanics and base behavior: without `wait_for_input` the in-flight
  and already-waiting sentences, `## Waiting`, and the three base-behavior
  `wait_for_input` clauses are dropped; Background commands keeps general
  command guidance and names only the remaining `command_read`/`command_wait`.
- Artifacts: without `sandbox_file_publish` the visual rule reads "Use the
  exact retained artifact id from an image tool receipt. A sandbox path is not
  an inline image source."
- Sandbox environment: the `rig_propose_change` and `rig_get` sentences need
  their tools.

Tool discovery, media, accepted user/workspace/Skill instructions, active-goal
continuation input, and the Codemode/code-search/Git-binding attempt
directives are unchanged.
