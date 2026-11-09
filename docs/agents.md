# Agents

An agent is one channel-independent record that replaces two older concepts:
[Slack agents](slack-bot.md#slack-agents) and [bot templates](bots.md#bot-templates).
It has a name, an icon, a description, Instructions, an optional First message,
Memory, a home workspace (where its chats run) and a visibility: Only me
(`private`) or the home workspace (`workspace`). Slack is one place an agent can
be available, per connected Slack installation.

The change ships as expand, migrate and contract releases
([migrations-expand-contract.md](migrations-expand-contract.md)). The API now
reads and writes only `agents`; since the contract
([Contract](#contract)) every legacy foreign key points at
`agent_slack_installs` and nothing writes `bot_templates` or `slack_agents`.
The legacy drop removes those tables.

## Data

Every id is kept: `agents.id` = `slack_agents.id` = `bot_templates.id`, so
Slack routes, interactions, proposals, intro posts, suggestions, the
`slack-agent:<id>` service principal and `?botTemplateId=` links all stay valid.

- `agents` (migration 1243): the directory row, owned by the home workspace.
  `visibility`, `owner_subject_id` (required for Only me), `name`, `name_key`
  (`lower(btrim(name))`, a clash hint, deliberately not unique), `description`,
  `avatar` (optional; initials otherwise), `memory_enabled` and
  `memory_collection_id`, `current_revision`, `origin` (`slack_agent`,
  `bot_template`, `app` or `slack`), `source_session_id`, creator, `version`
  for optimistic concurrency. `UNIQUE (id, account_id)` anchors the composite
  foreign keys below.
- `agent_revisions`: immutable content per revision: Instructions (up to
  20,000 characters), First message (up to 20,000) and the name and
  description as of that revision. The runtime role may only `SELECT` and
  `INSERT`; deleting the agent cascades.
- `agent_slack_installs`: where an agent is available in Slack, one row per
  agent and Slack connection, owned by the agent's home workspace so a rename
  updates it in the same transaction. `name_key` is the Slack handle key (same
  normalisation as `slack_agents.name_key`), unique per connection; `open` is
  the open-use switch; `install_workspace_id` (migration 1301) is the Slack
  installation's own workspace, where its routes and Slack records live.
  Deleting that workspace deletes the row. The announcement channel stays per
  installation in `slack_agent_update_settings`.
- The Slack records keyed by agent (`slack_channel_routes`,
  `slack_interactions`, `slack_agent_user_states`, `slack_agent_proposals`,
  `slack_agent_intro_posts`, `slack_agent_suggestions`) reference
  `agent_slack_installs (agent_id, connection_id)` (migrations 1304 to 1316):
  one agent in one installation, exactly what a `slack_agents` row was.
  Turning Slack off in an installation deletes its routes, user states, intro
  records and suggestions there and unlinks its chats and proposals
  (`ON DELETE SET NULL` of the agent column only), as before.
- `sessions.agent_id` (migration 1244): the agent a chat was started for. No
  foreign key (recheck on use). A trigger allows only one change, from NULL to a
  value. Forks copy it with the row; child workers never set it. It is
  unrelated to `agent_config` and `agent_access`. Index
  `sessions_agent_idx (workspace_id, agent_id, created_at DESC)` (migration
  1245, concurrent).
- `sessions.agent_prompt_revision`: the revision whose Instructions are in the
  chat's system prompt. NULL means a legacy chat whose instructions are already
  in `sessions.instructions`; such a chat never gets the agent layer.

### Row-level security

All three tables are FORCE RLS with the usual home `workspace_isolation`.

- `agents_organization_read`: anyone in the organization reads agents that are
  not Only me.
- `agents_private_isolation` (restrictive, like `channels_visibility_isolation`):
  a context without a person sees every row; otherwise an Only me agent is
  visible only to its owner (or an agent turn acting for them) in its home
  workspace.
- Revisions are never organization readable, and a restrictive policy hides a
  revision whenever its agent is hidden, so the Only me rule carries over.
- `agent_slack_installs_organization_read` lets Slack routing read
  installations from the Slack installation's own workspace; a restrictive
  policy hides an installation whenever its agent is hidden.

## Backfill

1243 copies the legacy rows once, as the table owner with FORCE RLS lifted:

- Each Slack agent becomes an agent in its target workspace, shared with the
  workspace, with Memory on and its collection, Instructions in revision 1 and
  one `agent_slack_installs` row (connection, team, `name_key`, `open`).
- Each bot template becomes an agent in its workspace with the same
  visibility (an Only me template's owner is whoever saved it), Memory off,
  the template text as the First message and empty Instructions. Chats started
  from a template are not linked.
- A template name that is all blanks (bot_templates allows it) becomes
  "Bot template".
- A template that shares a Slack agent's id is skipped (the Slack agent wins).

1244 links existing Slack agent chats to their agent from
`slack_interactions.slack_agent_id`, leaving `agent_prompt_revision` NULL.

## Sync during the rollout

From the expand release until the contract, older binaries wrote
`bot_templates` and `slack_agents`. `AFTER INSERT OR UPDATE OR DELETE`
triggers (1243) mirrored those writes into the agents tables; they did nothing
while `opengeni.agents_dual_write = '1'`, which the API switch set while it
wrote both shapes. The contract (1317) drops the triggers. Their functions stay
until the legacy drop, because the previous release's readiness check expects
them.

The legacy checks were widened so dual writes never fail: Slack agent names up
to 120 characters, descriptions 0 to 280 and Instructions up to 20,000;
template setup text 0 to 20,000.

## API

`/v1/workspaces/:workspaceId/agents` (contracts in
`packages/contracts/src/agents.ts`, SDK `listAgents`, `createAgent` and the other agent methods). The workspace in the
path is the agent's home.

| Route | Permission |
| --- | --- |
| `GET /agents?filter=all\|yours`, `GET /agents/:id` | `sessions:read`; Only me agents only for their owner |
| `POST /agents` | `sessions:create`; Only me needs a person who is a member of the organization |
| `PATCH /agents/:id` (`expectedVersion` required), `DELETE /agents/:id` | `sessions:create`, and whoever made it or a workspace admin (a workspace API key without a person counts as an admin, as for bot templates) |
| `GET /agents/:id/revisions?cursor&limit` | `sessions:read` |
| `GET /agents/:id/chats?filter=yours\|everyone&cursor&limit` | `sessions:read`; Only me chats and Slack DMs only for their owner |
| `GET /agents/:id/slack` | `sessions:read` |
| `PUT` and `DELETE /agents/:id/slack/:connectionId` | `workspace:admin`; turning `open` on also needs an organization admin |
| `GET /agents/:id/slack/:connectionId/channels`, `POST .../intro` | `workspace:admin` |

- Limits: name 1 to 120 characters, description up to 280, Instructions and
  First message up to 20,000 each. Validation is lenient (trimmed, clear
  messages); refusals carry `error.details.code` from `AGENT_ERROR_CODES`.
- Every change to Instructions or the First message adds a revision recording
  who made it; name and description changes are stored with the next one.
  Every change bumps `version`, including turning Slack on or off; recording
  the Memory collection once it exists does not.
- Slack needs a shared (`workspace`) agent outside a personal workspace. The
  Slack name rules are checked only when Slack is turned on (and on a rename
  while it is on). On a clash the agent already in Slack keeps its name and the
  other is refused (`agent_slack_name_taken`); agents are never merged.
- An agent can be available in any number of Slack installations.
- Turning Slack off in an installation deletes its `agent_slack_installs`
  row, and with it the agent's channel routes, user states, intro records and
  suggestions there; its older Slack threads in that installation lose their link
  to the agent (`slack_interactions.slack_agent_id` is set to null), so they no
  longer resolve to it if Slack is turned on again.
- The visibility rule is checked again under the agent's row lock, so an
  agent can never be Only me and in Slack at once.
- `PUT /agents/:id/slack/:connectionId` takes the availability's own
  `expectedVersion`; a conflict reports that version as
  `details.currentVersion`.
- Memory (`memoryEnabled`) creates the collection when switched on: workspace
  scope for a shared agent, the owner's personal scope for an Only me one. It
  is best effort and may wait for review under Review-first.

### Contract

Migrations 1301 to 1319, after the API switch is the previous release. Each
file that adds or drops a foreign key holds one key, so it locks the
referencing table and then the referenced one, the order writers take them in.

1. 1301 adds `agent_slack_installs.install_workspace_id` and copies it from
   `slack_agents.workspace_id`, and raises each
   agent's `version` to its legacy row's where that was higher (the legacy
   Slack agents API showed the greater of the two). A trigger on
   `slack_agents` fills the column for the previous release's writes during
   the rollout. 1302 adds its foreign key to `workspaces` `NOT VALID` and 1303
   indexes it concurrently.
2. 1304 to 1309 add the per-installation foreign keys `NOT VALID`, one table
   each (routes, interactions, user states, proposals, intro records,
   suggestions); 1310 validates them and 1302's.
3. 1311 to 1316 drop the foreign keys to `slack_agents`, one table each, and
   1317 drops the sync triggers.
4. 1318 and 1319 add unique indexes per installation (`connection_id`,
   agent, Slack person or channel) concurrently; the API writes against them.

The API no longer writes `bot_templates` or `slack_agents`. It only deletes an
agent's leftover `slack_agents` row when it renames the agent or removes the
agent or one of its installations: the previous release still inserts those
rows, and a stale one (its id or old name) would refuse it turning the agent
on again in an installation it left, or reusing a freed name, during the
rollout or after a rollback to it. Once the legacy drop has removed the table
this is skipped. The per-agent
unique keys `slack_agent_user_states_agent_user_uq` and
`slack_agent_intro_posts_agent_channel_uq` stay until the legacy drop because
the previous release names them in `ON CONFLICT`. Until then, the same Slack
person (Enterprise Grid) or shared channel (Slack Connect) in two installations
of one agent hits them, and that installation's hint, open notice or intro
record counts as already made.

Rolling back past the API switch is not safe once the contract is applied:
older binaries rely on the dropped triggers and foreign keys.

The API switch release itself (the previous release, during the rollout or
after a rollback to it) still finds an installation's workspace through
`slack_agents`, which this release no longer writes. An agent this release
turned on in Slack therefore falls back to its home workspace there, and an
agent in several installations is seen only through the installation it
joined first: in the others a pick from a route card answers that the agent
is gone, and turning it on in another installation is refused. That degrades
until this release serves again; it does not change any data.

### Chats bound to an agent

`POST /sessions` takes `agentId` (an agent the caller can see; Only me agents
only for their owner and only in Only me chats, which is the default when
`visibility` is omitted, otherwise `agent_requires_private_chat`; never for
child chats, `agent_child_chat`). The chat gets
`sessions.agent_id` and `agent_prompt_revision` = the agent's current
revision, so its Instructions reach the model through the worker's agent layer
([run lifecycle](run-lifecycle.md#agent-instructions)). The First message is
only prefilled by the app, never sent. Slack agent chats are bound the same
way and no longer copy the agent's Instructions into `sessions.instructions`;
the Slack-specific text (how the chat was reached, the other agents, handoff)
stays there. Post identity and an agent's chat list use `sessions.agent_id`,
falling back to the chat's Slack interaction (`slack_interactions.slack_agent_id`)
for older chats; caller-set metadata never names the agent. A chat list never
includes Site viewers' chats.

An Only me agent serves only its owner's Only me chats. Such a chat cannot be
made shared (`PUT /sessions/:id/visibility` refuses with
`agent_requires_private_chat`), and the worker reads its Instructions only
while the chat is its owner's Only me chat: shared chats with it (including
chats of an agent later made Only me) continue as plain chats. An Only me
agent needs Only me chats enabled in the organization to be used.

### Memory

One switch, "Remember across chats" (`memoryEnabled`). On: the agent has its
own Knowledge collection and its chats may read its other shared chats
(`slack_agent_chats`). Off: neither. The rules live in
`packages/core/src/domain/agent-memory.ts` and are enforced by the tools:

- Every chat of the agent with Knowledge tools reads its Memory, including
  entries still waiting for review (`view: needs_review`), which it is told are
  unreviewed.
- Only chats whose audience matches the collection write to it: a shared
  agent's shared chats, or an Only me agent's owner in a private chat. Private
  chats (Slack DMs included) of a shared agent, chats with Memory scope off and
  open-use chats only read. `knowledge_save`, `knowledge_archive` and
  `task_note_promote_knowledge` refuse such a write
  (`agent_memory_read_only`) when it names the collection or a collection
  inside it as a group, is the collection, or changes an entry in either. A
  worker a chat started is checked as its root chat's.
- A Slack DM is private through its Slack interaction while its session row is
  shared, so anything it saved would land in workspace Knowledge. An agent's
  Slack DM therefore saves no Knowledge at all (`agent_memory_read_only`),
  including `knowledge_retain_message` and `knowledge_retain_file`; it may
  still archive outside the agent's Memory. This closes the old leak,
  where Slack agents were told to save with workspace scope from DMs too.
- With Memory off, nothing is saved into the collection, `knowledge_search`
  and `knowledge_browse` on it and `knowledge_get` of it or its direct entries
  are refused (`agent_memory_off`; collections nested inside it stay ordinary
  workspace Knowledge), and `slack_agent_chats` lists nothing.
- `slack_agent_chats` never lists Only me chats or Slack DMs.
- An Only me agent's Memory and other chats are only for its owner's Only me
  chats; a shared chat with it (one shared later, or after the agent became
  Only me) runs as a plain chat: reads of the collection are refused and
  `slack_agent_chats` lists nothing.
- The chat is told its collection and whether it may save when it starts:
  Slack agent chats in their Slack instructions, app chats in their own
  instructions, which also get `slack_agent_chats`. The guidance is fixed when
  the chat starts; the tools apply the agent's current switch. When an app
  chat's own instructions leave no room, the guidance is left out rather than
  cutting them.

### Compatibility

`/bot-templates`, `/integrations/slack/agents`, the MCP tools
`bot_template_save` and `slack_agent_*`, `?botTemplateId=` links and
`slack-agent:<id>` principals keep working on top of `agents`:

- Bot templates list the agents the reader can see that have a First message
  (or were made as templates), with the First message as `setupInstructions`;
  the old gallery opens a template in a chat not bound to the agent, so other
  agents' Instructions would not apply. Get, change and delete by id work for
  every agent. A new template is an agent with empty Instructions.
- `bot_template_save` ("Make this an agent") creates an agent from the chat
  with standing `instructions` and an optional `firstMessage` (the older
  `setupInstructions` argument is taken as the First message), shared like
  the chat it was made from, with Memory off.
- Slack agents are the agents available in that installation, one record
  per installation (an agent in two installations shows in both lists, with
  the agent's own `version`). Item routes take `?connectionId=` for the
  installation; opening, deleting, channels and intros of an agent in several
  installations need it (`slack_agent_installation_required`). Deleting one
  through the old endpoint takes the agent out of that installation, and
  deletes the agent with its last one.

### Contract follow-ups

- The legacy drop: drop `bot_templates`, `slack_agents`, the sync and fill
  functions and the per-agent unique keys, and make
  `install_workspace_id` NOT NULL.
- Make the old Slack agent `DELETE` turn Slack off in that installation
  instead of deleting the agent, once nothing older depends on it.

## App

The sidebar's **Agents** page (`/workspaces/:id/agents`) replaces **Bot
templates** and the Slack agents list; `/bot-templates` redirects there.

- Agents page: All / Yours, one row per agent (icon, name, what it helps with,
  an Only me or Slack badge), **New agent** and **Import** (`.agent.json`, or an
  older `.bot.json` whose setup instructions become the First message). Banners
  say that templates and Slack agents became agents (shown when such agents
  exist, dismissible per browser), and a notice suggests renaming when names
  repeat.
- Agent page: **Chat** (`/sessions?agent=<id>`), **Export** (an `.agent.json`
  file with its name, icon, description, Instructions, First message and Memory
  switch; no ids, chats, Memory contents or Slack), its chats (Yours /
  Everyone's, each marked with where it started), Instructions, First message,
  **Remember across chats**, who can use it, and **Available in**: the app
  always, and one row per connected Slack workspace (`@Opengeni +handle`, open
  use, **Introduce in channels** at `/agents/:agentId/introduce/:connectionId`).
  An agent can be on in several Slack workspaces at once. Controls follow the
  agent's `viewer` access.
- Form: only the name is required. Lengths are checked on save with a count
  near each limit, never cut while typing. **Only me** is off with a reason
  where Only me chats aren't available.
- Composer: an agent chip ("Opengeni ▾" with a **Chat with** list and
  **Browse agents**) sets `?agent=<id>`; `?botTemplateId=` still works. A
  chosen agent's First message fills the composer; the chat starts with
  `agentId` (`app/lib/composer-agent.tsx`). Send waits while the agent loads;
  an agent that failed to load, or an Only me agent where Only me chats aren't
  available, shows why on the chip and blocks Send. An untouched First message
  is not saved in the server-side draft, so another tab or device never sees
  it without its agent. An Only me agent makes the chat Only me (Workspace is
  off with a reason) and going back restores the earlier choice.
- Agent chats show the agent's icon and name beside the title and a source
  line such as "Started in Slack by Kari". **Make this an agent** in the chat
  header's ⋯ menu opens a new agent prefilled from the chat's name, icon,
  description and instructions.

## Release plan

1. Expand: tables, session columns, backfill, sync triggers,
   wider legacy checks.
2. Worker: the agent Instructions prompt layer and a claim gate so older
   workers never run a chat that needs it (migration 1276; see
   [run lifecycle, "Agent instructions"](run-lifecycle.md#agent-instructions)).
3. API switch: read `agents`, write both shapes (with
   `opengeni.agents_dual_write`), bind `sessions.agent_id` and the revision when
   a chat starts. Old endpoints and frozen MCP tool names stay as
   compatibility layers.
4. App: the Agents page replaces bot templates and the Slack agents list.
5. Contract (this step), once step 3 is the previous release: point the
   legacy foreign keys at `agent_slack_installs`, stop writing the legacy
   tables, drop the sync triggers and allow several Slack installations per
   agent.
6. Drop the legacy tables once the contract is the previous release.
