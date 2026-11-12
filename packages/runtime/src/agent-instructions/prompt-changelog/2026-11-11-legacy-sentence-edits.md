# Modular prompt changelog: legacy sentence edits and variants

## Sentence edits (modular "all" vs legacy)

Settings in the chat. The blocked-tool rule offers the app action that makes a
blocking setting change, confirmed in the chat, before giving a next step (see
the first entry above).

```diff
- When something the user can fix blocks a tool, such as a missing connection, extension, machine, integration, permission or secret, offer the fix in the same reply: show its setup card, or the exact next step when there is no card, and continue once it is fixed.
+ When something the user can fix blocks a tool, such as a missing connection, extension, machine, integration, permission, setting or secret, offer the fix in the same reply: show its setup card, make the change with `admin_actions_search` and `admin_action_call` when an app action makes it (the user confirms it in the chat unless the session has full access), or give the exact next step when neither applies, and continue once it is fixed.
```

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
+ A reference is replaced by its value where something runs: shell commands, files, browser typing and connector tool calls.
+ Built-in workspace tools that store or send text (messages to other sessions, schedules, goals, notes, Slack or social posts) keep the reference as text, and the work that receives it resolves it when it runs something.
+ In a shell command or script, including `ogtool call`, write `\{{secret:Item}}` to pass one on.
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
- No sandbox or Connected Machine: the documents, file-publishing,
  sandbox-path, command-acknowledgement and CLI-list clauses listed at the top
  of this file are omitted or use their no-compute wording.
- `goals` off: the verification rule names "the user or applicable Skill"
  ("the user" without a readable Skill) and drops "the full completion audit".
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
  Without `session_create` the delegation-judgment sentences are dropped; the
  "After spawning" paragraph and the `child_requires_action` paragraph are
  dropped only with `childSessionsImpossible` (a session at its maximum
  nesting depth, which can have no children).
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
- Autonomy and persistence: the blocked-tool rule names `admin_actions_search`
  and `admin_action_call` only with `workspaceAdmin` on and neither tool
  proven absent; otherwise it keeps the legacy sentence.
- Secrets: the `secret_search` sentence and the Skill pointer need
  `secret_search`; the 2FA-enrollment and account-creation rungs of the login
  ladder need `secret_save`; the push-approval and hardware-key handoff line
  needs `interaction_request_human`. The reference and never-ask rules stay.

Tool discovery, media, accepted user/workspace/Skill instructions, active-goal
continuation input, and the Codemode/code-search/Git-binding attempt
directives are unchanged.

The Codemode directive no longer names `command_wait`/`command_read`, so with
every prompt-named tool proven absent no instruction layer names one (pinned by
a test).

Learning modes: with the accepted turn's effective Knowledge learning mode Off,
the Knowledge authoring tools (`knowledge_save`, `knowledge_prepare_save`,
`knowledge_retain_message`, `knowledge_retain_file`, `knowledge_archive`,
`task_note_promote_knowledge`) render as absent, and with workspace-instruction
learning Off so does `instruction_policy_save`. Their tools stay in the catalog
and still refuse; only the guidance for calls that cannot succeed is omitted.

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
