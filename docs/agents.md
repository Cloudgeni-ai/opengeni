# Agents

An agent is one channel-independent record that replaces two older concepts:
[Slack agents](slack-bot.md#slack-agents) and [bot templates](bots.md#bot-templates).
It has a name, an icon, a description, Instructions, an optional First message,
Memory, a home workspace (where its chats run) and a visibility: Only me
(`private`) or the home workspace (`workspace`). Slack is one place an agent can
be available, per connected Slack installation.

The change ships as expand, migrate and contract releases
([migrations-expand-contract.md](migrations-expand-contract.md)). The API now
reads and writes `agents` and keeps the legacy rows in sync for older
releases ([API](#api)); the legacy tables go in the contract step.

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
  the open-use switch. The announcement channel stays per installation in
  `slack_agent_update_settings`.
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

## Sync until the contract step

Older binaries keep writing `bot_templates` and `slack_agents` during and
after the expand release. `AFTER INSERT OR UPDATE OR DELETE` triggers mirror
those writes:

- Only the columns the write changed are copied, so fields an agent gained in
  the new model stay. A new revision is added only when the text the legacy
  table owns changed (a template's First message, a Slack agent's
  Instructions); the other text is carried over from the current revision.
- Deleting a legacy row deletes the agent. A template never changes an agent
  whose origin is a Slack agent. A new Slack agent that shares a template
  agent's id takes that agent over (it becomes a shared Slack agent with
  Memory on and keeps the First message).
- The triggers run as the writer and switch the tenancy settings to the
  agent's home workspace with no person, then restore them, because a Slack
  agent's row lives in the installation's workspace while its agent lives in
  the target workspace. Every update must change exactly one row, and a write
  whose agent is out of reach fails rather than syncing nothing. Deletes may
  find nothing, because a workspace deletion can cascade to the agent first.
- They do nothing while `opengeni.agents_dual_write = '1'`. Code that writes
  both shapes sets it transaction-locally, so, for example, turning Slack off
  (deleting the legacy `slack_agents` row) never deletes the agent.

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
- For now an agent is available in at most one Slack installation
  (`agent_slack_single_install`), because `slack_agents.id` is the agent's id
  and `slack_channel_routes` still points at `slack_agents`.
- Turning Slack off deletes the legacy row, and with it the agent's channel
  routes, intro records and update settings in that installation; its older
  Slack threads lose their link to the agent
  (`slack_interactions.slack_agent_id` is set to null), so they no longer
  resolve to it if Slack is turned on again.
- The visibility rule is checked again under the agent's row lock, so an
  agent can never be Only me and in Slack at once.
- `PUT /agents/:id/slack/:connectionId` takes the availability's own
  `expectedVersion`; a conflict reports that version as
  `details.currentVersion`.
- Memory (`memoryEnabled`) creates the collection when switched on: workspace
  scope for a shared agent, the owner's personal scope for an Only me one. It
  is best effort and may wait for review under Review-first.

### Dual write

Every write updates `agents` (and a revision, and `agent_slack_installs`) and
the legacy rows in the same transaction, with
`set_config('opengeni.agents_dual_write', '1', true)` so the sync triggers
stand aside:

- `bot_templates` for agents whose origin is a bot template (First message as
  `setup_instructions`);
- `slack_agents` while the agent is available in Slack, in the installation's
  workspace and targeting the home workspace (Instructions, `open`, Memory
  collection, `version` mirrored). Turning Slack off deletes that row, not the
  agent.

The backfill started agents at version 1, so during the rollout the legacy
Slack agents API shows the greater of the agent's and its legacy row's
version, accepts either, and raises the agent's version to match before a
write.

Older pods keep reading and writing the legacy rows during a rolling deploy,
and the triggers carry their writes over.

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
- Slack agents are the agents available in that installation. Deleting one
  through the old endpoint deletes the agent.

### Contract follow-ups

- Point `slack_channel_routes` (and the other legacy foreign keys) at `agents`
  and lift the one-installation limit.
- Store the installation's home workspace on `agent_slack_installs` (today it
  comes from the legacy `slack_agents.workspace_id`).
- Make the old Slack agent `DELETE` turn Slack off instead of deleting the
  agent, once nothing older depends on it.

## Release plan

1. Expand: tables, session columns, backfill, sync triggers,
   wider legacy checks.
2. Worker: the agent Instructions prompt layer and a claim gate so older
   workers never run a chat that needs it (migration 1276; see
   [run lifecycle, "Agent instructions"](run-lifecycle.md#agent-instructions)).
3. API switch (this step): read `agents`, write both shapes (with
   `opengeni.agents_dual_write`), bind `sessions.agent_id` and the revision when
   a chat starts. Old endpoints and frozen MCP tool names stay as
   compatibility layers.
4. App: the Agents page replaces bot templates and the Slack agents list.
5. Contract, once step 3 is the previous release: point the legacy foreign keys
   at `agents`, stop writing the legacy tables and drop the sync triggers.
6. Drop the legacy tables a release later.
