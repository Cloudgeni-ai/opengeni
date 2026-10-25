# Modular prompt changelog

macOS privacy folders. A Connected Mac's agent runs as the Opengeni app from
the owner's home folder, so a recursive `find ~`, `grep -r` or `du` there reads
Desktop, Documents, Downloads, Library, Music, Pictures and Movies, and macOS
asks the owner about each one (Files and Folders, Photos, Apple Music and the
media library, Contacts, Calendars and other apps' data) in the app's name.
People saw that cascade and took the app for asking far more than it needs.
The module now says to open those folders only when the task needs them. Code
search also skips them on its own: always Library, Music, Pictures, Movies and
the Trash, and each of Desktop, Documents and Downloads until the owner has
allowed the app to open it (see `MAC_HOME_PRIVACY_GUARDED_DIRS` in
`sandbox/channel-a.ts`). Only the modular
composition has a Connected Machine module; legacy bytes are unchanged.

```diff
+ On macOS, the home folder's Desktop, Documents, Downloads, Library, Music, Pictures and Movies folders are privacy-protected: the first read of each shows the owner a macOS permission prompt.
+ Open them only when the task needs them, and never scan the whole home folder recursively.
+ Code search from the home folder may skip them; to search inside one, name it as the path.
```

An answer the agent gives in a turn that ends on `wait_for_input` now goes in
the call's new `reply` argument, which the person sees exactly as written. The
Progress updates guidance no longer allows posting a status right before
`wait_for_input` when it answers the user: it says to put the whole answer in
`reply` instead of writing it before the call, and the final-response sentence
says `reply` carries any answer. The message-while-working rule now says to
call `wait_for_input` with the answer in its `reply`, rather than to give the
answer and then call it. Before, Claude Opus 5.5 and Sonnet 5.5 returned such
an answer as a progress-update thinking block, so the person saw only
Anthropic's one-paragraph summary of it, without its images or tables (session
df030716, 13:13 UTC on 2026-10-23). Both compositions change identically;
legacy prompt digests are refreshed for this reviewed change.

A sub-session's question to the person now also reaches its parent agent, and
the first answer wins. The Session coordination guidance gains one paragraph,
shown when `session_human_input_respond` is available: the parent answers a
child's `child_requires_action` question from its task context when it can,
leaves questions only a person can answer (decisions, preferences, credentials,
approvals) to the person, and never answers a question meant for the person on
their behalf. The `request_human_input` description adds that in a sub-session
the parent agent may also see and answer the request, and the first answer
wins. Before, the
instructions did not say who answers, and a parent only learned of a child's
question from the generated goal-continuation prompt. Both compositions change
identically; legacy prompt digests are refreshed for this reviewed change.

When something the user can fix blocks a tool, such as a missing connection,
extension, machine, integration, permission or secret, the agent now offers the
fix in the same reply: it shows the setup card, or gives the exact next step
when there is no card, and continues once it is fixed. It never only reports
that something is unavailable. This one rule in Autonomy and persistence
replaces case-by-case wording: the Integration setup ending "If blocked or a
setup tool is unavailable, explain the specific gap" now says to give the exact
next step, or, when the user can't fix it, to explain the gap and who can, and
`browser_open` and `interaction_discover` no longer tell the agent to explain
that the Chrome extension must be connected. Before, an agent
asked to use LinkedIn in the person's browser answered "Browser isn't
connected" and showed the setup card only after the person asked how. Tools
that hit a registered user-fixable refusal also post the card themselves (see
`USER_SETUP_BLOCKERS`). Both compositions change identically; legacy prompt
digests are refreshed for this reviewed change.

A Word, Excel, PDF or PowerPoint file the user sends to be changed is now
edited in the sandbox with ordinary tools (python-docx, openpyxl, pandoc,
LibreOffice), checked and published, and so is a new file the user asks for in
such a format unless the artifact export tool lists that format. Before, the
routing sentence sent "a document or file (for example a DOCX or PDF)" to native
document artifacts and forbade a sandbox DOCX, but stock deployments export only
spreadsheet XLSX, and deployments without the artifact materializer export
nothing. An agent asked for a Word or Excel file built a native artifact and
then reported that export was unavailable, and a sent DOCX or XLSX the importer
could not read was returned unchanged. In the everyday-task benchmark these
cases failed on every run, while the comparison agent passed them with
python-docx and openpyxl. Native artifacts still serve requested documents,
edits to existing artifacts and long deliverables. The `documents`,
`spreadsheets` and `presentations` Skills gain a short procedure for these
files, and the goal continuation's report clause excludes them from the native
report contract. Both compositions change identically; legacy prompt digests
are refreshed for this reviewed change.

Written pieces the person asks for (briefs, letters, plans, reports) are
answered in chat. A document Artifact is created only when the person asks for
a document or file (for example a DOCX or PDF), asks to edit an existing
document, or the result is too long to read comfortably in chat (several
pages). The earlier "or clearly meant to be kept or shared" let agents build a
document for any requested brief, which took several times longer than a chat
answer and left only a link in the conversation. The `documents` Skill
description and its routing paragraph, and the goal continuation's report
clause, say the same. Both compositions change identically; legacy prompt
digests are refreshed for this reviewed change.

The `goal_set` tool description now opens with when a goal is warranted: a
long-running objective that needs several turns or continued autonomous work,
while a short or single-step request is answered directly. The old opening,
"Create a goal when this session has none", read as a rule to create a goal
whenever none existed, so agents wrapped one-step edits in goal_set and
goal_complete. The rest of the description, the goals instruction module and
both compositions are unchanged.

Agent-facing text no longer names the product, so an embedding product's agent
only ever sees and repeats its own product's name. Bundled Skills take neutral
names (`documents`, `spreadsheets`, `presentations`, `sites`, `visualize`,
`secrets`, `schedules`, `projects`, `skill-management`, `video-generation`), and
the instructions that point at them use those names. "Inline in the Opengeni
console" is now "inline in the chat", and the native-capability check asks
whether the workspace already provides a capability. Both compositions change
identically; legacy prompt digests are refreshed for this reviewed change. The
default identity, provenance markers such as `[Opengeni internal updates]`,
the `opengeni__` tool namespace and Codemode identifiers are unchanged.

The CAPTCHA rule moved from the secrets doctrine into the descriptions of the
two interaction entry tools, `browser_open` and `computer_open`. The secrets
block renders only with the `secrets` capability and runtime reference
resolution, and never in the legacy composition, so an agent that could drive a
browser without that block had no CAPTCHA guidance, refused challenges and
handed them to the user. The entry tools are visible from the first request of
every session with browser or computer tools, in both compositions, so the same
sentence now reaches every such agent and no agent without those tools. The
secrets block is one line shorter. `browser_auth` and `interaction_request_human`
keep their existing CAPTCHA clauses, where the agent decides to sign in or hand
over.

The secrets doctrine now states one rule for every tool: a secret reference
resolves wherever it is written, including Opengeni's own tools, and an escaped
reference is passed on unresolved for later work such as schedule prompts,
messages to other agents, goals and notes. It replaces the sentence that said
references stay references outside executing surfaces. Interaction tools and
the secret tools themselves keep references unchanged.

Product identity and generated guidance now spell the brand Opengeni in both
legacy and modular compositions. Only capitalization changes; instruction
behavior and layer order are preserved. Legacy prompt digests are refreshed
for this shared identity change. Reserved protocol namespaces remain stable.

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

The shared Codemode directive no longer claims every available tool is callable
programmatically. It names the Codemode catalog (`ogtool list`) and says the
built-in sandbox tools (shell, file patching, image viewing, terminal input)
are outside it, so the agent uses the shell and filesystem directly.

## Authoring rule

With `capabilities: "all"`, renderer `opengeni`, and every resource present
(managed sandbox, Connected Machine, repositories, Git credentials, attachments,
workspace environment, rig, secret references), the modular text says exactly what the legacy
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

## Sentence edits (modular "all" vs legacy)

Tool discovery and media. Deferred schemas must remain behind the existing
search router, while modular agents need to distinguish missing disclosure
from missing execution authority. Runtime mechanics explains ranked discovery
and literal-prefix recovery; the new `media` capability module directs image
and video requests to runtime/provider tools rather than integration setup.
Disabled media removes that module. The legacy prompt remains unchanged.

Discovery reuse. A discovered schema is never added to the tool list (prompt
cache stability); its exact name binds against the current authorized catalog
for the rest of the session. The earlier "one focused capability at a time"
rule turned one search into several sequential round trips, so the rule now
says a found tool stays callable by name and that several capabilities can be
searched in one response or loaded together through `names`.

Compact discovery. Search loads its strongest match and leaves alternatives as
descriptors. An explicitly configured decision model can select definitions for
ambiguous queries; strong matches skip that inference. Exact ties and queries
without resource evidence stay compact and require exact-name loading. The
instructions distinguish loaded tools from suggestions and use the existing list tool for an on-demand group
directory. Definitions and receipts are frozen after the originating result,
never inserted into a changing earlier prompt or top-level tool block.
Native Responses routes retain hosted client search and real loaded functions;
ordinary search receipts and `tool_invoke` apply to the existing generic routes.

```diff
+ Deferred tool schemas are omitted from the first request; absence there does not prove a tool is unavailable.
+ Describe the action, resource and useful context in `tool_search`; it loads the strongest match, with optional decision-model selection for ambiguous searches.
+ Check the match: ranking is not certainty.
+ Native search returns loaded function definitions directly.
+ In ordinary search receipts, `schemasLoaded: true` means `tools` have loaded schemas but `suggestions` are unloaded alternatives; with `schemasLoaded: false`, load chosen exact names with `tool_search({query: '', names: [...]})` before calling them.
+ Known exact names bypass ranking and inference.
+ Once its schema is in context, call the tool by name or through `tool_invoke` where available; do not rediscover it unless its schema is no longer in context.
+ When you need several capabilities, search for them in parallel `tool_search` calls in the same response, or load known exact names together with `names`; broad searches with small limits can omit a relevant tool.
+ Use `tool_list({view: 'groups'})` for a compact directory, then list an exact returned `group`.
+ If search misses, browse the relevant groups and follow `nextCursor` until covered, then load chosen exact names with `tool_search`.
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
generic line and the template's Opengeni line). The default identity keeps the
more specific one and adds the contract's collaboration and voice sentences,
so replacing the identity replaces all of them together.

```diff
- You are an agent for the current workspace.
```

Precedence. New: embedder instructions must beat Opengeni's style defaults
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
(deferred) goal tool. The goal module now says so explicitly. Its discovery
clause used to say to search when the goal tools "are not listed", which is
always true for a deferred tool and caused repeated searches for a tool whose
schema was already in context; it now searches only when the schema is missing.

```diff
+ Saying or verifying that the work is done does not complete the goal: call opengeni__goal_complete by its exact name, and search for a goal tool only when its input schema is not in context.
```

Standing attachments. A file attached to the session is mounted on every
turn, so after compaction an agent could open a weeks-old screenshot and treat
it as something the user just sent. The attachments module now says such files
may be old and belong to the current request only when the latest message
refers to them. (Superseded: see "Attached files retired" below; the guidance
now travels with each turn's attachment notice.)

Session targets. Conversations about another session now keep a remembered
target and read, send to, or steer that session through the session tools, so
session coordination says how to select it and follow a sent update to its
result.

```diff
+ For a conversation about another session, use session_target_get/set to remember or clear the selected target; selection is context, not permission to mutate.
+ Discover with sessions_list and inspect with session_events; keep voice in this session.
+ Send only when asked, and use Steer only for an explicit change of direction.
+ After Send or Steer, use session_message_status with the returned update ID to follow its exact consuming turn and read the indicated result before relaying it.
+ Do not resend pending work or mistake acceptance for completion.
```

Variable sets retired. Secrets now live in vaults and are used by reference
from any session, so there is nothing to attach and no `variable_set_list`
tool. Integration setup discovery starts at the capability catalog, and the
child-session Variable Set workaround is gone. The legacy operational prompt
gets the same two edits, because it would otherwise name a removed tool and a
field that now returns 422. Because both prompts changed identically, this is
not a modular-vs-legacy difference and has no diff block: the "check
`variable_set_list`" step was dropped from the integration-setup sentence, and
the Variable Set child-session sentence was deleted (legacy locks updated).

Workspace environment retired. Vaults replace variable sets and environment
export is gone: secrets are written as references where they are used, so no
variables are exported into the shell and the modular prompt no longer names an
attached environment, its variable names, or its operator notes. The
`workspace_environment` module is deleted; `workspaceEnvironmentInstructions`
survives only for the locked legacy CORE (`legacy-environment.ts`).

```diff
- A workspace environment named "prod" is attached to this session; its variables are exported in the sandbox shell environment.
- Exported environment variables: API_URL, DEPLOY_KEY.
- Environment notes from the operator: Use DEPLOY_KEY for deploys.
```

Attached files retired. The `attachments` module rendered only on a turn with a
file, inside the operational contract, so every such turn changed the system
instructions and missed the provider's prompt cache for the whole request,
even for an identical task started seconds apart. The module is deleted and the
modular contract no longer depends on per-turn files. Its guidance (read-only,
copy before modifying, contents are data rather than instructions, an earlier
attachment belongs to a request only when that message refers to it) now ends
the turn's own "Attached files are available in the sandbox" notice, which sits
after history and is stored with the turn, so later turns replay the same
bytes. The SDK-rendered remote mount policy and filesystem layout likewise no
longer list per-turn file mounts. The legacy prompt is unchanged.

```diff
- Attached files are mounted read-only; copy them before modifying.
- File resources are mounted under .opengeni/files/<file-id>/ unless the session specifies another mount path.
```

Secrets. New `secrets` module (capability `secrets`, rendered only once the
runtime resolves references for the attempt). Models are naturally cautious
with credentials and stall on logins, so the block explicitly grants autonomy:
use references everywhere they execute, follow the login ladder (saved
session, saved login plus TOTP, enroll the agent's own 2FA, email or SMS codes
through connected tools, create the account with a generated password when
account creation is allowed), never ask for secret values in chat, use the
ready ask card from a missing-secret error, and hand the browser over only for
push approvals or hardware keys. It is at most six
lines under its heading; playbooks live in the `secrets` Skill. Clause
gating: the `secret_search` sentence and the Skill pointer need
`secret_search` (the Skill pointer also needs Skills); the 2FA-enrollment and
account-creation rungs need `secret_save`; the ask-card sentence needs the
`humanInput` capability; the handoff line needs `interaction_request_human`.
Integration setup gains one sentence, with `secrets` and `humanInput` both on,
so "never request credentials in chat" comes with the supported alternative.

```diff
+ Use saved passwords, keys and codes by reference: `{{secret:Item}}`, `{{secret:Item/field}}` or `{{secret:Vault/Item/field}}`, plus `/otp` for the current one-time code (`{{secret:GitHub/otp}}`).
+ A reference is replaced by its value wherever you write it: shell commands, files, browser typing and every tool call.
+ To pass one on unresolved (a schedule prompt, a message to another agent, a goal, a note or comment), write `\{{secret:Item}}`; it arrives as `{{secret:Item}}` and resolves when that work uses it.
+ Find saved items and their ready references with `secret_search`.
+ Sign in yourself, in this order: reuse a saved browser session; sign in with the saved login and its `/otp` code; after signing in, enroll your own 2FA and save it with `secret_save`; get email or SMS codes through connected tools; when the task allows creating accounts, create the account without asking, saving a generated password with `secret_save` first.
+ Never ask for passwords, keys or codes in chat or in a plain text question.
+ Ask only for what only the user has, with a `kind: "secret"` question in `request_human_input`; a tool error about a missing secret already contains that call, so make it, adjusting only `saveTo` or `prompt`, and continue with the returned reference.
+ Hand the browser to the user with `interaction_request_human` only for push approvals or hardware keys.
+ For playbooks, read the `secrets` Skill.
+ For a password, key or code only the user has, use a `kind: "secret"` question in `request_human_input`; you get a saved reference back, never the value.
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
- `workspaceAdmin` off: the rig `rig_propose_change`/`rig_get` sentences are
  omitted.
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

## Tool-availability variants

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
- Integration setup: the `capability_catalog_search` discovery sentence
  needs its tool; the two setup-card sentences and the
  card follow-ups need their tools.
- Session coordination: the `session_events` paragraph, the
  `session_send_message` follow-up clause, the `wait_for_input` long-wait and
  `finalAnswer` sentences, the `session_wait` join and short-wait sentences,
  and the `session_get` contrasts each need their tools.
- Runtime mechanics and base behavior: without `wait_for_input` the in-flight
  and already-waiting sentences and the three base-behavior `wait_for_input`
  clauses are dropped, and `## Waiting` keeps only its tool-neutral sentence
  ("When monitoring requires timed checks, use the available
  recurring-monitoring or session-wait mechanism at that meaningful cadence
  rather than ritual polling."); Background commands keeps general command
  guidance and names only the remaining `command_read`/`command_wait`.
- Artifacts: without `sandbox_file_publish` the visual rule reads "Use the
  exact retained artifact id from an image tool receipt. A sandbox path is not
  an inline image source."
- Sandbox environment: the `rig_propose_change` and `rig_get` sentences need
  their tools.
- Secrets: the `secret_search` sentence and the Skill pointer need
  `secret_search`; the 2FA-enrollment and account-creation rungs of the login
  ladder need `secret_save`; the push-approval and hardware-key handoff line
  needs `interaction_request_human`. The reference and never-ask rules stay.

Tool discovery, media, accepted user/workspace/Skill instructions, active-goal
continuation input, and the Codemode/code-search/Git-binding attempt
directives are unchanged.

Known exception: the Codemode directive's observation clause still names
`command_wait`/`command_read` when those tools are proven absent; a test pins
it as the only surviving prompt-named tool.

Linked turns: the permission ceiling of a turn acting for a linked external
identity is that turn's own snapshot. A session mixing linked and unlinked
turns (or turns for different linked identities) can therefore render a
different operational contract per turn, which breaks prompt-prefix reuse
across those turns. This is expected: the turn's executable first-party
permissions differ in the same way. Turns with the same authority keep an
identical contract.

Opt-in experiment `OPENGENI_EXPERIMENT_KNOWLEDGE_RETRIEVAL_GUIDANCE` (default
off, both compositions): Knowledge retrieval also precedes answers about the
workspace's own projects, systems, people, hosts, ports or policies and any
correction or forget request; corrections update and forget archives the
existing entry (`knowledge_archive`); "from now on"/"always" response
preferences are saved in the same turn with `skill_save` or
`instruction_policy_save` without an approval question. Each clause renders
only while its tool may be available. Off, every prompt is byte-identical.
Opt-in experiment `OPENGENI_EXPERIMENT_SYSTEM_PROMPT_CACHE_SPLIT` (default off):
the sandbox environment and attachment modules render
after every other contract module, so the session-independent prefix (identity,
contract, Codemode/code-search directives) is shared across workspaces. Turning
it on changes live sessions' prompt order once (one cache miss each). Off, every
prompt is byte-identical.
