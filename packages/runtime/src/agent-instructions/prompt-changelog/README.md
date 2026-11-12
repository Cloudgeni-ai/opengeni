# Modular prompt changelog

One Markdown file per change, in this directory, so parallel PRs never edit the
same lines. Never edit another change's entry to add yours; add a new file.

## Adding an entry

Name the file `<YYYY-MM-DD>-<slug>.md`: the UTC date you write it, then your
branch's topic in lowercase kebab case (letters, digits and single hyphens), for
example `2026-11-12-site-visibility-tool-text.md`. Your branch name is unique,
so the name cannot collide with a parallel PR, and the files sort by date.
`test/agent-instructions/prompt-legacy-diff.test.ts` rejects any other name.

An entry says what changed for the model and why, records the size delta in
bytes or tokens, and lists every sentence edit against the legacy prompt in a
`diff` block (`- ` removed, `+ ` added). A later change that reverts or rewords
a sentence an earlier entry added edits that earlier `diff` line; that is the
only reason to touch another entry.

An open PR that still edits the old single `PROMPT_CHANGELOG.md` will conflict
once: drop its hunk from that file and put the same paragraph and `diff` lines
in a new entry file here.

## Authoring rule

With `capabilities: "all"`, renderer `opengeni`, and every resource present
(managed sandbox, Connected Machine, repositories, Git credentials, attachments,
workspace environment, rig, secret references), the modular text says exactly what the legacy
contract, default template, and CORE say, sentence for sentence, except for the
edits listed in the `diff` blocks of the entry files in this directory. `test/agent-instructions/prompt-legacy-diff.test.ts`
splits both texts into sentences (headings and list markers are layout, not
content) and fails when the difference is not exactly this list. Add an entry
file here, with its reason, in the same change as any wording edit.

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
     `connected_machine`, `repositories`, `rig`, `artifacts`, `media`, `goals`,
     `subagents`, `knowledge`, `skills`, `secrets`, `admin`, `attachments`
     (last because it varies per turn). The `workspace_environment` id stays in
     the contracts so stored inspector snapshots parse, but nothing renders it.
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
- CORE's rig block became `# Sandbox environment`. CORE's workspace
  environment block has no modular counterpart (see "Workspace environment
  retired").
