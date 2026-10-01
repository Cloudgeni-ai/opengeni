# Modular prompt changelog

Sessions with an agent configuration (`sessions.agent_config` non-null) get their
system instructions from this folder. Sessions without one keep the legacy
composition (`operational-instructions.ts` + the persona template + CORE in
`../index.ts`) byte for byte; `test/agent-instructions/legacy-prompt-lock.test.ts`
pins those bytes.

The legacy locks track the reviewed upstream CORE. After main's #3053 added
the four goal-completion handoff sentences, the locks and worker request hashes
were refreshed against main `709eef238d523a892b54e43304d4e1fdaa393eba`.
All fourteen omitted/null legacy cases retain that main composition and layer
order exactly. The modular goals module retains those sentences verbatim too;
they are not intentional removals or modular-only additions.

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
     waiting and `wait_for_input`, compaction, background commands.
   - Conditional modules, in this order: `renderer_markdown`, `sandbox`,
     `connected_machine`, `repositories`, `workspace_environment`, `rig`,
     `artifacts`, `goals`, `subagents`, `knowledge`, `skills`, `admin`,
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
