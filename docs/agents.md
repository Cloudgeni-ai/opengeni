# Agents

An agent is one channel-independent record that replaces two older concepts:
[Slack agents](slack-bot.md#slack-agents) and [bot templates](bots.md#bot-templates).
It has a name, an icon, a description, Instructions, an optional First message,
Memory, a home workspace (where its chats run) and a visibility: Only me
(`private`) or the home workspace (`workspace`). Slack is one place an agent can
be available, per connected Slack installation.

The change ships as expand, migrate and contract releases
([migrations-expand-contract.md](migrations-expand-contract.md)). Only the expand
step has landed: the new tables exist and stay in sync with the legacy ones,
but nothing reads them yet, so the product behaves as before.

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

## Release plan

1. Expand (this step): tables, session columns, backfill, sync triggers,
   wider legacy checks.
2. Worker: the agent Instructions prompt layer and a claim gate so older
   workers never run a chat that needs it.
3. API switch: read `agents`, write both shapes (with
   `opengeni.agents_dual_write`), bind `sessions.agent_id` and the revision when
   a chat starts. Old endpoints and frozen MCP tool names stay as
   compatibility layers.
4. App: the Agents page replaces bot templates and the Slack agents list.
5. Contract, once step 3 is the previous release: point the legacy foreign keys
   at `agents`, stop writing the legacy tables and drop the sync triggers.
6. Drop the legacy tables a release later.
