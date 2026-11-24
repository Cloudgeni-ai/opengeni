# Agents

An agent is one channel-independent record that replaces two older concepts:
[Slack agents](slack-bot.md#slack-agents) and [bot templates](bots.md#bot-templates).
It has a name, an icon, a description, Instructions (the one text saying
what it does and how), Memory, a home workspace (where its chats run) and a
visibility, its **Who can use it**: Only me (`private`), people in the home
workspace (`workspace`), or anyone in the organization (`organization`,
[Anyone in the organization](#anyone-in-the-organization)). An agent works
wherever its workspace is connected: a shared agent is available in the app
and in every Slack workspace linked to its home workspace, with no separate
step, and who can use it there is still its own access
([Available everywhere](#available-everywhere)).

The change ships as expand, migrate and contract releases
([migrations-expand-contract.md](migrations-expand-contract.md)). The API now
reads and writes only `agents`; since the contract
([Contract](#contract)) every legacy foreign key points at
`agent_slack_installs`, and the legacy drop ([Legacy drop](#legacy-drop))
removed the `bot_templates` and `slack_agents` tables.

## Data

Every id was kept: `agents.id` is the old `slack_agents.id` or
`bot_templates.id`, so
Slack routes, interactions, proposals, intro posts, suggestions, the
`slack-agent:<id>` service principal and `?botTemplateId=` links all stay valid.

- `agents` (migration 1243): the directory row, owned by the home workspace.
  `visibility`, `owner_subject_id` (required for Only me), `name`, `name_key`
  (`lower(btrim(name))`, a clash hint, deliberately not unique), `description`,
  `avatar` (optional; initials otherwise), `memory_enabled` and
  `memory_collection_id`, `organization_access` (migration 1379; anyone in
  the organization, on a shared agent), `current_revision`, `origin` (`slack_agent`,
  `bot_template`, `app` or `slack`), `source_session_id`, creator, `version`
  for optimistic concurrency. `UNIQUE (id, account_id)` anchors the composite
  foreign keys below.
- `agent_revisions`: immutable content per revision: Instructions (up to
  20,000 characters from a person, up to 40,022 with an older First message
  joined; see [One text](#one-text)), the older `first_message` (empty since
  migration 1452) and the name and description as of that revision. The
  runtime role may only `SELECT` and `INSERT`; deleting the agent cascades.
- `agent_slack_installs`: where an agent is available in Slack, one row per
  agent and Slack connection, owned by the agent's home workspace so a rename
  updates it in the same transaction. `name_key` is the Slack handle key (same
  normalisation as the old `slack_agents.name_key`), unique per connection;
  `open` was the open-use switch (unread since migration 1448, kept equal to
  `agents.organization_access` for the previous release); `install_workspace_id` (migration 1380,
  required since 1439) is the Slack
  installation's own workspace, where its routes and Slack records live.
  Deleting that workspace deletes the row. The announcement channel stays per
  installation in `slack_agent_update_settings`.
- The Slack records keyed by agent (`slack_channel_routes`,
  `slack_interactions`, `slack_agent_user_states`, `slack_agent_proposals`,
  `slack_agent_intro_posts`, `slack_agent_suggestions`) reference
  `agent_slack_installs (agent_id, connection_id)` (migrations 1383 to 1396):
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
wrote both shapes. The contract (1397) drops the triggers. Their functions stay
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
| `POST /agents` | `sessions:create`; Only me needs a person who is a member of the organization; `organization` needs an organization admin |
| `PATCH /agents/:id` (`expectedVersion` required) | `sessions:create`, and whoever made it or a workspace admin (a workspace API key without a person counts as an admin, as for bot templates), or anyone who can start chats there when its **Who can edit** is everyone ([Who can edit](#who-can-edit)); changing who can use or edit it stays with whoever made it and admins; changing it to `organization` also needs an organization admin |
| `DELETE /agents/:id` | `sessions:create`, and whoever made it or a workspace admin |
| `GET /agents/:id/revisions?cursor&limit` | `sessions:read` |
| `GET /agents/:id/chats?filter=yours\|everyone&direct&cursor&limit` | `sessions:read`; Only me chats and Slack DMs only for their owner; `direct=true` leaves out Slack threads that only mentioned the agent |
| `GET /agents/:id/slack` | `sessions:read`; also catches the agent up in the linked Slack workspaces |
| `PUT /agents/:id/slack/:connectionId` | `workspace:admin`; the older `open` field sets **Anyone in the organization** for the agent (turning it on needs an organization admin) |
| `DELETE /agents/:id/slack/:connectionId` | always `409 agent_slack_always_available`: there is nothing to turn off |
| `GET /agents/:id/slack/:connectionId/channels`, `POST .../intro` | `workspace:admin` |

### Who can edit

A shared agent's **Who can edit** (`editAccess`, migration
`1561_agent_edit_access.sql`) is `creator_and_admins` (whoever made it and the
workspace's admins) or `everyone` (also anyone in its workspace who can start
chats there). Agents made in Opengeni's own apps and by agent tools start as
`everyone`; a create request that leaves it out (`POST /agents`, a ready-made
agent's `POST /agent-templates/:key/agents`, `/bot-templates`) gets
`creator_and_admins`, as before the setting, and agents made before it keep
`creator_and_admins`, today's rule. It governs every edit of the agent: its
name, icon, Instructions, Remember across chats, Can use and Skills, through
`/agents`, `/bot-templates`, the SDK and agent tools; with `everyone`, that
includes the Instructions and Can use its automations run with. What it
remembers is Knowledge, governed by Knowledge's own permissions. Who can use it, Who can edit and
deleting it stay with whoever made it and admins (`viewer.canManage`). Each
edit rechecks the setting under the agent's row lock, so a concurrent change
to it can't be raced. An Only me agent stays its owner's whatever the setting
says. The agent page shows it as one row under Who can use it, read-only for
people who can't manage the agent. Triggers aren't agent edits: an automation
runs as its own owner, so anyone who may create automations can point one at
an agent they can use.

- Limits: name 1 to 120 characters, description up to 280, Instructions up
  to 20,000 (an older client's `firstMessage` too, which joins them). Validation is lenient (trimmed, clear
  messages); refusals carry `error.details.code` from `AGENT_ERROR_CODES`.
- Every change to Instructions adds a revision recording
  who made it; name and description changes are stored with the next one.
  Every change bumps `version`, including Slack availability a person
  changes; Opengeni adding the agent to Slack on its own, and recording the
  Memory collection once it exists, do not.
- Slack needs a shared (`workspace`) agent outside a personal workspace. When
  a shared agent is created, renamed or shared, its name is checked against
  every linked Slack workspace: a name Slack can't use is refused
  (`agent_slack_name_invalid`, 422) and so is a name another agent there
  answers to (`agent_slack_name_taken`, 409, with `connectionId` and
  `slackTeamName`); agents are never merged. A kept name is never rechecked, so
  older agents still save.
- An agent is available in every linked Slack installation at once
  (`agent_slack_single_install` is never returned any more).
- Leaving Slack (an agent made Only me) deletes its `agent_slack_installs`
  rows, and with them the agent's channel routes, user states, intro records
  and suggestions there; its older Slack threads lose their link to the agent
  (`slack_interactions.slack_agent_id` is set to null), so they no longer
  resolve to it once it is shared again.
- Making an agent Only me takes it out of every Slack workspace in the same
  transaction, under the agent's row lock (exactly like turning Slack off
  used to), so an agent can never be Only me and in Slack at once. Sharing it
  again makes it available again.
- `PUT /agents/:id/slack/:connectionId` takes the availability's own
  `expectedVersion`; a conflict reports that version as
  `details.currentVersion`. Each row of `GET /agents/:id/slack` has
  `availability`, or `unavailable` with the `AGENT_ERROR_CODES` value saying
  why not (Only me, personal workspace, or the name).

### Available everywhere

A shared agent outside a personal workspace is available in every Slack
workspace linked to its home workspace: each active Opengeni Slack app
installed there or shared with it by the organization
(`availableSlackBotConnectionMetadata`) with an active installation binding.
Availability is still one `agent_slack_installs` row per agent and
installation, because threads, channel settings and intros hang off it;
`apps/api/src/integrations/agent-slack-availability.ts` keeps the rows in
step:

- at once, when an agent is created or changed through `/agents`,
  `bot_template_save` or the older `/bot-templates` API, so the reply and the
  next Slack message already see it. The organization's older agents not in
  Slack yet are placed first, oldest first, so a new name never takes theirs;
- when a Slack installation reads its agents for routing
  (`loadSlackAgentsForConnection`), for every shared agent of the workspaces
  it is linked to that it is missing: agents that existed before, agents a
  compatibility path or an older release made, and Slack workspaces connected
  later. It runs at most once a minute per installation and process. When two
  such agents share a name, the older one gets it;
- when the agent's Slack rows are read (`GET /agents/:id/slack`).

An agent whose name Slack can't use, or that another agent there already
answers to, stays out of that Slack workspace and its page says why. Nobody
turns availability on or off; any member who may make a shared agent
(`sessions:create`) makes one people can ask in every linked Slack workspace,
including Slack apps the organization shares. Before, that took a workspace
admin. The older `/bot-templates` API still accepts names Slack can't use or
that clash; such an agent stays out of Slack and its page says why. Who may use it there is the agent's own
**Who can use it**: members of its workspace, or also linked organization
members when it is set to anyone in the organization. No migration: these are the rows turning Slack on always
wrote, and an older release reads them as turned on. During a rolling deploy,
servers on an older release may still refuse Only me for an agent in Slack,
show the old switch (which can turn Slack off), or show an agent in several
Slack workspaces as in one of them; a server on this release adds the agent
back within a minute.
- Memory (`memoryEnabled`) creates the collection when switched on: workspace
  scope for a shared agent, the owner's personal scope for an Only me one. It
  is best effort and may wait for review under Review-first.

### Anyone in the organization

**Who can use it: Anyone in <organization>** (`visibility: "organization"`)
lets every linked, full member of the organization use a shared agent from
chat integrations, even without access to its workspace. It replaces Slack's
per-installation "Organization members can use this agent in Slack" switch:
one setting on the agent, which Slack follows in every linked Slack workspace
and other integrations (Teams) read the same way.

- Choosing it, through the form, `POST`/`PATCH /agents` or the older `open`
  field of `PUT /agents/:id/slack/:connectionId` and the Slack agents API,
  needs an organization admin (the request's verified `account:admin`), as
  the switch did. Narrowing it back needs only the usual edit rights. Making
  an agent Only me turns it off. Personal workspaces don't offer it, and an
  imported `.agent.json` is never opened on its own.
- Who may use it from an integration is unchanged from Slack's open agents
  ([slack-bot.md](slack-bot.md#open-agents)): on every message the
  integration must positively say the person is a full member of the
  connected team in a conversation only that team can see, their account
  there must be linked to an Opengeni person, and that person must be an
  active, full member of the agent's organization, read live. They are told
  once that the workspace's members can see what they say, and their chat
  runs as the agent's read-only service principal. The integration-neutral
  checks are in `apps/api/src/integrations/organization-agents.ts`
  (`agentOpenToOrganization`, `organizationAgentAskerPerson`); Slack's own
  team and conversation check stays in `slack-open-agents.ts`.
- Storage: `agents.organization_access` (migration 1379, default false) on a
  `workspace` agent, the only source since 1448
  ([Legacy drop](#legacy-drop)); the API says `organization`. Every write
  still keeps `open` on each of its installations equal to the column, for
  the previous release, which decided by `open` while an agent was in Slack
  (open only if every installation's was). Its changes during the rollout
  write the column too, so they hold here.

### Contract

Migrations 1380 to 1399, after the API switch is the previous release. Each
file that adds or drops a foreign key holds one key, so it locks the
referencing table and then the referenced one, the order writers take them in.

1. 1380 adds `agent_slack_installs.install_workspace_id` and copies it from
   `slack_agents.workspace_id`, and raises each
   agent's `version` to its legacy row's where that was higher (the legacy
   Slack agents API showed the greater of the two). A trigger on
   `slack_agents` fills the column for the previous release's writes during
   the rollout. 1381 adds its foreign key to `workspaces` `NOT VALID` and 1382
   indexes it concurrently.
2. 1383 to 1388 add the per-installation foreign keys `NOT VALID`, one table
   each (routes, interactions, user states, proposals, intro records,
   suggestions). 1389 then cleans up rows that would fail them, as each key's
   `ON DELETE` action would have: installation rows whose workspace is gone
   are deleted, chats and proposals naming an agent with no installation row
   for their connection are unlinked (kept), and such routes, user states,
   intro records and suggestions are deleted; a `NOTICE` reports the count
   per table. 1390 validates the keys, including 1381's.
3. 1391 to 1396 drop the foreign keys to `slack_agents`, one table each, and
   1397 drops the sync triggers.
4. 1398 and 1399 add unique indexes per installation (`connection_id`,
   agent, Slack person or channel) concurrently; the API writes against them.

The contract release no longer wrote `bot_templates` or `slack_agents`. It
only deleted an agent's leftover `slack_agents` row when it renamed the agent
or removed the agent or one of its installations: the release before it still
inserted those rows, and a stale one (its id or old name) would have refused
it turning the agent on again in an installation it left, or reusing a freed
name. It skips that once the legacy drop has removed the table. The per-agent
unique keys `slack_agent_user_states_agent_user_uq` and
`slack_agent_intro_posts_agent_channel_uq` stay until the legacy drop because
the previous release names them in `ON CONFLICT`. Until then, the same Slack
person (Enterprise Grid) or shared channel (Slack Connect) in two installations
of one agent hits them, and that installation's hint, open notice or intro
record counts as already made. The legacy drop removes them.

Upgrade requirement (self-hosted and embedded deployments included): apply
the contract only when every running binary already contains the API switch
(#7274, with #6922, #7000, #7156, #7281, #6998 and #7275), so upgrade through
such a release first. Rolling back past the API switch is not safe once the
contract is applied: older binaries rely on the dropped triggers and foreign
keys, and their legacy writes would fail the new keys.

The API switch release itself (the previous release, during the contract's
rollout or after a rollback to it) still finds an installation's workspace
through `slack_agents`, which the contract release no longer writes. An agent
the contract release turned on in Slack therefore falls back to its home
workspace there, and an
agent in several installations is seen only through the installation it
joined first: in the others a pick from a route card answers that the agent
is gone ("That agent no longer exists"), the legacy Slack agents item routes
answer 404 for an agent whose installation lives in another workspace, and
turning it on in another installation is refused. A previous release that
has the agent page's Move here (the one-Slack-workspace limit) offers it for
such an agent; using it deletes the other installation's channel settings,
which this release then adds back empty. These are accepted rollout and
rollback effects: they fail closed (refuse or hide, never widen access) and
end when this release serves again.

### Legacy drop

Migrations 1437 to 1447, after the contract is the previous release:

1. 1437 adds `CHECK (install_workspace_id IS NOT NULL) NOT VALID`; 1438
   validates it; 1439 sets the column `NOT NULL` (no scan, thanks to the
   validated check) and drops the check. There is no second copy: 1380, its
   fill trigger and the contract's own writes leave no row without the
   workspace. Should a row still lack it, 1437 repairs it first, so 1438
   can't fail: it sets the Slack connection's workspace (the installation's
   own workspace, what the API writes) and removes a row whose connection has
   none, as turning Slack off there would (the API places a shared agent again
   in every linked Slack workspace). A `NOTICE` reports both counts. It lifts
   FORCE row-level security on `agent_slack_installs` for this, and on
   `connections` only when a row needs repair.
2. 1440 and 1441 drop the per-agent unique keys, so the same Slack person or
   channel in two installations of one agent gets a record in each.
3. 1442 to 1444 drop `slack_agents`'s own foreign keys, one referenced table
   per file, each locking the referenced table first and then `slack_agents`,
   the order a cascading delete takes them in. 1445 drops `slack_agents`,
   locking only it (and stops if a foreign key is left), and 1446
   `bot_templates`, locking `workspaces` first (no `CASCADE`: nothing
   references them); 1447 drops
   the sync and fill trigger functions. During 1443, a workspace or account
   delete that reaches `slack_agents` through its own cascade can still
   deadlock with it; PostgreSQL aborts one side and the file is safe to
   rerun. The contract release's delete of a leftover `slack_agents` row
   touches none of the referenced tables, and once the table is gone it
   skips the delete. The explicit locks put 1442 onwards in the release's
   maintenance span, and each of 1442 to 1444 and 1446 can hold up readers
   of the referenced table for up to two 5 second lock timeouts, one per
   lock it takes (dropping such a key locks it anyway).

Readiness no longer lists the two tables or the functions. The compatibility
layers below, `?botTemplateId=` links and `slack-agent:<id>` principals keep
working: they never needed the legacy rows.

The same release takes two more contract steps:

- **Anyone in the organization** (1448): `agents.organization_access` becomes
  the only source. 1448 copies onto it the value the previous release read
  while an agent was in Slack (open only if every installation's `open` is),
  as the migration owner with FORCE row-level security lifted on `agents` and
  `agent_slack_installs`; a `NOTICE` reports the count. Nothing reads `open`
  any more. Every write still sets `open` on each of the agent's
  installations to the column, because the previous release reads it: if it
  stopped, closing an agent here would leave it open to that release's
  servers. A later step stops writing and drops it. Every change the
  previous release makes during the rollout writes the column too, so it
  holds; a raw `open` change alone no longer counts.
- **First message** (1449 to 1452; [One text](#one-text)): every revision's
  older First message is joined to its Instructions and emptied. 1449 adds
  the revision bounds again with Instructions up to 40,022 characters (the
  most the join makes) `NOT VALID`, 1450 validates it, 1451 drops the old
  20,000-character check, and 1452 joins, as the migration owner with FORCE
  row-level security lifted on `agent_revisions`; a `NOTICE` reports the
  count. The `first_message` column stays, empty, for the previous release
  until a later step drops it.

Rollback past this release: a binary older than the contract would find
`slack_agents` and `bot_templates` gone and must not run (the contract's
upgrade requirement already rules that out). The contract release (the
previous one) keeps working: it never wrote or needed the legacy tables,
reads `open`, which stays equal to the column, and shows the same
Instructions, since it joined the First message the same way.

### Chats bound to an agent

`POST /sessions` takes `agentId` (an agent the caller can see; Only me agents
only for their owner and only in Only me chats, which is the default when
`visibility` is omitted, otherwise `agent_requires_private_chat`). A child
chat can be bound too: that is delegation (below); `agent_child_chat` is no
longer returned. The chat gets
`sessions.agent_id` and `agent_prompt_revision` = the agent's current
revision, so its Instructions reach the model through the worker's agent layer
([run lifecycle](run-lifecycle.md#agent-instructions)). Agents have no First
message; the app selects the agent and leaves the composer as it is. Slack agent chats are bound the same
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
(`slack_agent_chats`). Off: neither. New agents start with it on in the app
form, from a chat (`bot_template_save`) and from Slack; existing agents keep
their setting, and the API's `CreateAgentRequest.memoryEnabled` still
defaults to off when omitted. The rules live in
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

### One text

Agents used to have a second text, a First message the app put in the
composer. Now Instructions are the one text saying what an agent does, and
the First message is read as part of them: `agentInstructionsWithFirstMessage`
(`@opengeni/contracts`) joins it after the Instructions as its own paragraph
led by "When a chat starts:" (it was what a new chat opened with, so it stays
something for the start of a chat rather than a standing rule), unless they
already contain it. Since migration 1452 every stored revision is joined
that way ([Legacy drop](#legacy-drop)), so reads take the Instructions as
stored; `first_message` stays, empty, until a later step drops it:

- Every read (the API, the editor, Slack, a chat's agent layer) shows the
  Instructions; `firstMessage` is always empty and `hasFirstMessage` false
  (both kept for older clients).
- A First message sent with a change joins the Instructions in the new
  revision, even when together they pass the 20,000 characters a person can
  write (the database allows up to 40,022). Rollout: the previous release
  still keeps the two apart in that one case, so such a revision written by
  it during the rollout keeps its First message unread until that later
  step joins and drops it.
- A `firstMessage` from an older client, `bot_template_save`'s older
  `firstMessage`/`setupInstructions`, and `/bot-templates`
  `setupInstructions` all become Instructions. The legacy `bot_templates`
  and `slack_agents` rows are no longer written ([Contract](#contract)).
- A chat with an agent whose current revision has a First message gets it as
  part of its Instructions from then on.
- Rollback: the previous release reads agents stored this way as
  Instructions with no First message, and keeps working.

### Compatibility

`/bot-templates`, `/integrations/slack/agents`, the MCP tools
`bot_template_save` and `slack_agent_*`, `?botTemplateId=` links and
`slack-agent:<id>` principals keep working on top of `agents`:

- Bot templates list the agents the reader can see that were made as
  templates, with their Instructions as `setupInstructions` (the old gallery
  opens a template in a chat not bound to the agent, as composer text). Get,
  change and delete by id work for every agent. A new or changed template's
  `setupInstructions` are its Instructions.
- `bot_template_save` ("Make this an agent") creates an agent from the chat
  with standing `instructions` (the older `firstMessage` and
  `setupInstructions` arguments join them), shared like the chat it was made
  from, with Memory on and its collection saved by the chat's live turn (under
  that chat's Agent learning). Its result's `memory` says whether that
  collection is `ready`, `pending_review`, `learning_off` or `not_saved`.
- `bot_template_save` checks a shared agent's name against the linked Slack
  workspaces like `POST /agents`, makes it available there, and returns
  `slack: [{ slackWorkspace, ask, where }]` (`ask` is, for example, `@Opengeni
  Staging Growth analyst`), so the chat can tell the person how to ask it.
- Slack agents are the agents available in that installation, one record
  per installation (an agent in two installations shows in both lists, with
  the agent's own `version`). Item routes take `?connectionId=` for the
  installation; channels and intros of an agent in several installations
  need it (`slack_agent_installation_required`), unless exactly one of them
  belongs to the path workspace, which is then used. Open use is the agent's own
  and changes it in every installation. Deleting one through the old
  endpoint deletes the agent: a shared agent can't leave only one linked
  Slack workspace.

### Starts when, Can use, Learns and Skills

An agent is set up from its page; these fields are on the agent (migration
1517: `tool_permissions`, `skills`, `template_key`) and in `Agent` /
`AgentSummary` (`toolPermissions`, `skills`, `templateKey`, defaulting to
empty for older servers). `PATCH` replaces `toolPermissions` or `skills` as a
whole.

- **Starts when**: the agent's triggers are ordinary automations with
  `agentConfig.agentId` (an agent's `scheduled_tasks_create` call may give
  `agentConfig.agentName`, a name or id, which the tool resolves like
  `session_create`'s `agentName`), in any chat mode. A chat the scheduler starts
  (`new_session_per_run`, or the first run of `reusable_session`) is bound to
  the agent (its Instructions, Memory and Can use), created as the task with
  the task owner's access to the agent (`agent.subjectId` on session create),
  so Only me agents work in their owner's Only me automations. A chat's agent
  never changes, so changing a `reusable_session` automation's agent clears
  its chat (`reusableSessionId: null`); the next run starts a new chat with
  the new agent. The task records the chat it left in
  `metadata._opengeniAgentChatChange` (`{ sessionId, agentId, changedAt }`,
  `SCHEDULED_TASK_AGENT_CHAT_CHANGE_METADATA_KEY`), the edit writes the audit
  event `scheduled_task.agent_chat_changed`, and the automation form says so
  with a link to the previous chat. `existing_session` keeps the agent and
  needs a chat bound to that agent (`sessions.agent_id`) that the owner can
  control; any other chat is refused with 422 "That chat isn't with this
  agent", and the form marks such chats "Not a chat with this agent". Saving
  checks the agent is one the owner can use, against the automation's agent,
  run mode, chat and visibility after the edit. Any trigger type in the catalog works,
  including types added later, because the trigger is the automation's own.
  Event runs keep the automation limits: the chain limit, the storm guard
  (`maxRunsPerHour`) and usage limits. The page lists the automations with
  an on/off switch (pause/resume) and remove. **Add trigger** opens a small
  dialog on the page (`agent-trigger-dialog.tsx`, the picker in
  `agent-trigger-picker.tsx`, pure parts in `agent-trigger-model.ts`). Its
  picker is built from the source catalog the Add a source page uses
  (`eventSourceChoices`), so it names no kind itself: **Schedule**, each of
  the person's event sources (and ready ones they can use without adding,
  such as This workspace; one that is off or needs attention shows greyed
  with why and keeps its kind from being offered again), then every kind they can still add, including
  **Create a webhook**; each shows its app's logo, or its glyph or initial.
  A kind added to the catalog, or a source of a kind the client doesn't
  know, shows up with no change here. Picking a source shows its events and
  optional conditions; picking a kind not added yet shows its setup step in
  place: Opengeni adds GitHub, Slack or This workspace right there, a
  webhook is created right there and shows its URL and signing secret, a
  webhook from an app (Linear, Sentry, Tailscale or another app) is created
  right there and then shows its URL with one field for the secret that app
  shows and **Save <secret>** (sent once with `updateEventSource`, stored
  encrypted on the source like the Add a source page does, never returned or
  shown again; afterwards the dialog says only "<secret> set." with
  **Replace**, which only the source's owner or an admin sees; a webhook
  still blocked waiting for its secret can be picked by them to paste it),
  GitHub not yet connected to the
  workspace makes **Connect GitHub** the one action (Connected tools), and
  any other kind (Gmail's mailbox to connect or pick, an MCP server to pick)
  makes **Add <source>** the one action (the Add a source page). A GitHub
  trigger's **Repositories** (`agent-trigger-repositories.tsx`) are all the
  GitHub connection reaches (the default) or the ones chosen, saved as a
  `data.repository.full_name` condition (`equals` or `in`, at most 50) on
  each GitHub trigger; an automation with a new chat per run keeps no
  repository, and one that continues a chat keeps the chosen ones. The condition
  names the repository, so it stops matching once the repository is renamed
  or transferred (choose it again then). Each new-chat run of an agent's trigger
  checks out the repositories its GitHub events are about (at most 5): the
  worker attaches each, after the chat is admitted and before its first turn,
  only when one of the workspace's own GitHub App installations offers it in
  the allowlist, through the ordinary attach (`attachSessionRepositoryResource`),
  which checks the allowlist again. Other automations keep only the
  repositories they were saved with, and so does an agent's trigger that has
  a repository of its own. The worker asks GitHub, through the allowlisted
  installation, to resolve the event's `owner/name` and attaches it only when
  GitHub's id is the allowlisted one, with GitHub's name and default branch
  (event data can come from a test event), as the scheduler, so a repository
  someone removed from the chat stays removed. Migration 1556 gave agents' GitHub
  triggers saved with one repository (before they named it in a condition, so
  they fired for every repository) an `equals` condition for it; other
  automations were left as they are. The **Note** is
  optional: each run gets the event and the agent's Instructions do the
  rest (an empty note sends "Handle this event." or "Do your scheduled
  work."). **Chat** (`agent-trigger-chat-field.tsx`) says where runs go:
  **New chat each run** (the default, `new_session_per_run`), **One chat
  for this trigger** (`reusable_session`) or **An existing chat**
  (`existing_session` with `targetSessionId`, offering only chats started
  with this agent, read through the server's agent filter
  `GET /v1/workspaces/:id/agents/:agentId/chats?filter=everyone&direct=true`, the
  same list the automation form offers); the dialog's description says which. It saves
  through `createScheduledTask` with `agentConfig.agentId`, named
  `<agent>: <when>`, and with an explicit `visibility`: `private` for an
  Only me agent, otherwise `workspace` (never the organization's default
  for new schedules). The server's rules for who may create a shared
  automation still apply; a refused one says so in the dialog. **Open full
  form** opens the automation form with `?agent=<id>&returnTo=agent`, plus
  `?source=<id>` for the source picked, for every other setting, with the
  note and chat choice (in history state, `agentTriggerStart`, so the note
  never enters the address); its back link, Cancel and Save
  return to the agent's page. The automation form's **Chat** row starts
  with the chat composer's agent picker, so an automation's agent can be
  changed (or removed) there; the change is saved like any other edit
  (`agentConfigPatch.agentId` for an existing chat).
  The list comes from the server
  (`GET /v1/workspaces/:id/scheduled-tasks?agentId=<id>`, SDK
  `listScheduledTasks({ agentId })`), which filters on
  `agentConfig.agentId`; a server without the filter ignores it and the page
  then filters what it got.
- **Can use**: rules `{connector, tool, permission}`. `connector` is a
  connection's server id, a provider domain such as `github.com` (any
  connection to that provider; what ready-made agents use), or `*`; `tool` is
  a tool name or `*`. The most specific rule wins (server id, then domain,
  then `*`; an exact tool over `*`; ties take the strictest), see
  `agentToolPermissionFor` in `@opengeni/contracts`. Rules only make chats
  stricter: **Ask first** and **Block** raise the decision the connection's
  own tool permissions give (`minimumDecision` on the connector action
  ledger), and **Allow** follows the connection. They apply to every call
  that goes through the connector action policy: native connectors,
  Opengeni's own GitHub tools (`github_app`, `github_personal`, which a
  `github.com` rule names), MCP servers, gateway (Codemode) calls and Codex
  Apps, which now goes through the same approvals with a default of Allow. A
  blocked tool is refused with a reason, not hidden. A chat follows its own
  agent and every agent above it, taking the strictest choice: an agent's
  workers follow its Can use, and a delegated chat follows both its own
  agent's and the caller's, so handing work over never drops a restriction.
  In an unattended run Ask first refuses the call, as approvals do there.
  When a rule is what made a call ask or blocked it, the refusal names the
  agent and its rule (`blocked by the agent "Triage" (its Can use rule
  blocks pull_request_merge of github.com)`), and the call's record keeps it: `agentRule`
  (`{agentId, agentName, connector, tool, permission}`) on `ToolActionReview`
  and `connector_action_requests.agent_rule` (migration `1531`). The other
  fields are unchanged (`reasonCode` stays `blocked_by_default` or
  `asks_by_default`), so older clients show the same refusal as before.
  Codex Apps calls carry no provider domain: rules name them by the
  `codex_apps` server id or `*`. A rule a release can't fully read (such as
  a permission added later) asks first rather than being ignored. The
  page lists only the connections that have a rule, each with the logo the
  chat composer's Connectors picker shows (`connectionLogoResolver`: the
  catalog entry's logo, else one filed under its provider's domain, else the
  name's initial), with its all-tools choice and any tool set on its own;
  **Choose per tool** lists the rest of its tools, and choosing the reset
  option removes a rule. **Add rule** picks a connection from a searchable
  list with logos (the workspace's enabled connections, one per rule key,
  plus **GitHub** for Opengeni's own GitHub tools, rules on `github.com`,
  unless a connection already covers it), then all its tools or one tool,
  then Allow, Ask first or Block. Rules for connections not listed (another
  person's, or not set up yet) still show, named by their key, and can be
  changed or removed.
- **Learns**: **Remember across chats** plus the entries of the agent's
  Memory collection, each editable and removable (Knowledge entry save and
  archive).
- **Skills**: a short list of the Skills it relies on, each shown by its
  name and short description and linked to the Skill's page. One searchable
  list adds another (name and short description; ones already chosen are not
  offered). A chosen Skill is saved by its key and shown from the workspace's
  Skill catalog (matched by key, then by title), so a Skill written in
  Opengeni shows its name, never its generated `authored-<id>` key; a
  reference no Skill here matches says so. It is a note for the people
  setting the agent up: every Skill stays available to every chat, so there
  are no per-Skill switches.

Not in self-hosted deployments without these pieces: Codex Apps rules need
the Codex Apps deployment flag, Slack lines need the Opengeni Slack app, and
the GitHub row only has an effect with the GitHub App or Your GitHub set up.
Writes through `git` and `gh` with Your GitHub follow Can use too: a
`github.com` or `github_personal` rule applies to the GitHub action each
write maps to (for example `pull_request_merge` for `gh pr merge`). `gh`
and GitHub API reads are refused when the agent chain blocks every built-in
GitHub read tool (for example a `github.com` `*` Block rule). A read can't
be mapped to one tool reliably, so a Block on a single read tool applies only
to Opengeni's GitHub tools, and Ask first isn't applied to reads (the gateway
has no read approvals; `gh` would fail rather than wait). `git clone` and
`git fetch` aren't checked: the chat's own checkout needs them.

### Ready-made agents

`GET /v1/workspaces/:id/agent-templates` lists ready-made agents and
`POST /v1/workspaces/:id/agent-templates/:key/agents` (`{name?, visibility?}`)
adds one as an ordinary agent with `templateKey` set (SDK
`listAgentTemplates`, `createAgentFromTemplate`). They are content files in
`packages/core/src/agent-templates/*.agent.json` (schema `AgentTemplate`),
listed in gallery order in its `index.ts`: Triage, Bug fixer, PR reviewer,
CVE scanner, Incident responder and Dependency updater, general for any software team, with
Instructions written for autonomy with judgment (pick up work with what they
can reach instead of asking for setup first, hand off to each other by name,
and involve a person only when blocked or a decision needs one), suggested Can use rules
(each blocks merging a pull request, through a GitHub connection or
Opengeni's own GitHub tools) and suggested triggers:

| Agent | Does | Hands off to | Suggested triggers |
| --- | --- | --- | --- |
| Triage | Sorts new issues and reports | Bug fixer | A GitHub issue opens; a new message in a Slack channel; a Linear issue is created |
| Bug fixer | Reproduces and fixes a bug in a pull request | PR reviewer | An issue is labelled `bug` |
| PR reviewer | Reviews pull requests | None | A pull request opens or is ready for review; someone on the team mentions it on a pull request (one click) |
| CVE scanner | Checks lockfiles and container images against known advisories (GitHub advisories, or osv-scanner or trivy in its sandbox), ranks by reachability and severity, fixes safe upgrades in one pull request, reports the rest | PR reviewer | Every Monday at 08:00; a pull request opens or is ready for review |
| Incident responder | Gathers logs, metrics and recent deploys from connected tools, posts the likely cause and a mitigation | Bug fixer | Any event on a webhook (`*`, for alerts from monitoring); a new message in a Slack channel |
| Dependency updater | Batches patch and minor upgrades into one pull request a week | PR reviewer | Every Monday at 09:00 |

GitHub events carry no changed file paths, so CVE scanner's pull request
trigger fires for every pull request and its run stops at once when no
lockfile, dependency manifest or Dockerfile changed. The Agents page lists
the ones not added here yet under the workspace's agents, as **Ready-made**
(each one click to add, then its page), for someone who can add agents; **Add
agent** offers the same. A new ready-made agent
is one more content file; no product code names any of them. Suggested triggers are
never created on add: the agent page offers each with **Set up**, which
opens the same dialog filled in from the suggestion (its events,
conditions, note and name) so the person only picks the source and, for
GitHub, the repositories, then saves; a GitHub, Slack or This workspace source
it lacks is added on save. Its **Open full form** opens the automation form
at the suggestion (`?agent=<id>&agentTrigger=<n>&returnTo=agent`). A
suggestion marked `oneClick` needs no choices and shows **Add** instead: it
saves at once on the person's GitHub source (added first when GitHub is
connected), or opens the same dialog when anything else is missing. PR
reviewer's **Review when mentioned on a PR** is one: it listens for
`issue_comment.created` on pull requests and
`pull_request_review_comment.created` whose `data.comment.mentions_app` is
true (the comment @mentions Opengeni's GitHub App, as `@slug` or
`@slug[bot]`) and whose `data.comment.author_association` is `OWNER`,
`MEMBER` or `COLLABORATOR`; the App's own comments never start it. Ready-made agents
name no internal Skills. Each names the `team` it is for ("Engineering"); Capabilities
**Ready-made** groups by it.

### Delegation by name

An agent hands work to another agent of the same workspace by name or id:
`session_create`'s `agentName` (the shared `agentRefToolInput` and
`resolveDelegationAgent` in `apps/api/src/agent-delegation.ts`, which an
outside agent's `delegate` tool reuses). The child is bound to that agent
(Instructions, Memory guidance, Can use) and its final answer returns to the
caller like any worker's. The child keeps the calling chat's privacy, and
its Memory guidance matches it. Who can use the agent is checked for the
person the calling chat acts for: an Only me agent only for its owner in Only
me chats (a shared chat considers shared agents only), and from an open Slack
chat only agents anyone in the organization can use. An Only me calling chat
uses its owner's agents whoever runs the turn, so an Only me automation's run
can hand work to its owner's other Only me agents (the child is bound with
`agent.subjectId` set to the owner). The caller's Can use still applies in
the child (see Can use above).
A name two agents share is refused with `agent_name_ambiguous` and their ids;
an unknown one with `agent_not_found`. Delegated chats keep the nested agent
depth limit. Triage hands bugs to "Bug fixer", which asks "PR reviewer"; Incident responder hands
fixes to "Bug fixer", and CVE scanner and Dependency updater ask "PR reviewer".

### Follow-ups

Once the legacy drop is the previous release: stop writing
`agent_slack_installs.open` and drop it, and join any First message the
previous release kept apart during the rollout, then drop
`agent_revisions.first_message`.

## App

The sidebar's **Agents** page (`/workspaces/:id/agents`) replaces **Bot
templates** and the Slack agents list; `/bot-templates` redirects there.

- Agents page: All / Yours, one row per agent (icon, name, what it helps with,
  and an Only me badge on an agent that stays in the app; every shared agent is
  in Slack, so there is no Slack badge), **New agent** and **Import** (`.agent.json`, or an
  older `.bot.json` whose setup instructions become the Instructions). Banners
  say that templates and Slack agents became agents (shown when such agents
  exist, dismissible per browser), and a notice suggests renaming when names
  repeat.
- Agents page: **Add an agent** lists ready-made agents not yet added here,
  each with **Add**, which opens the new agent's page.
- Agents page: **Add agent ▾** starts with **Create with chat**. It asks
  "What should the agent do?" and opens a new chat with that request
  (`agentChatOpeningMessage`, the dialog in `apps/web` shared with
  automations' Create with Opengeni). The chat follows the bundled `agents`
  Skill (`builtin:agents`, offered when the chat has `bot_template_save`): it
  drafts the name, Instructions, Can use, Skills and triggers, asks once with
  `request_human_input` (which common triggers, then Create agent / Change
  something), saves with `bot_template_save` (which also takes
  `toolPermissions` and `skills`) and adds each picked trigger with
  `scheduled_tasks_create`, named "<agent>: <trigger>". No new storage or
  endpoint: the agent and its triggers are the ordinary ones.
- Common triggers (`commonAgentTriggers()` in contracts): **When a pull
  request opens**, **When mentioned on a PR** (the same events and team-only
  conditions as the PR reviewer's one-click trigger) and **Every weekday
  morning** (09:00 Monday to Friday, in the browser's time zone). GitHub ones
  are offered only when the workspace's GitHub isn't disconnected and the
  agent's Can use doesn't block GitHub. They cover every repository the GitHub
  connection reaches; the full automation form narrows them. On the agent page
  **Starts when** lists the agent's own ready-made suggestions first, then the
  common triggers they don't already cover, at most three, as off switches
  (`agentTriggerOffers`); turning one on adds the automation at once, or opens
  the trigger dialog when its source needs setup. A shared agent in Slack shows
  a read-only "When mentioned in Slack" row: Slack mentions reach it natively,
  so there is no Slack trigger to add.
- Agent page: **Chat** (`/sessions?agent=<id>`), **Export** (an `.agent.json`
  file with its name, icon, description, Instructions and Memory switch; no
  ids, chats, Memory contents or Slack; an older file's First message joins
  the Instructions on import), then **Instructions**, **Starts when**, **Can
  use**, **Learns**, **Who can use it** and **Skills** (see above), and its
  chats (Yours / Everyone's). Who can use it ends with one row per linked
  Slack workspace with no switch: "Ask in Slack: `@Opengeni <Name>`" and
  **Introduce in channels** at `/agents/:agentId/introduce/:connectionId`, or
  why it isn't there (Only me or its name). An agent is in several Slack
  workspaces at once. Controls follow the agent's `viewer` access. Choosing
  Only me in the form says it stops answering in Slack; a Slack name refusal
  shows at the name.
- Agent page cost: people who may see Insights > Usage (workspace settings
  authority) see one line under the header, "Last 30 days: $12.40 · $0.310 per
  run", or "No runs in the last 30 days" (`agent-cost.tsx`). It reads
  `.../insights/usage?range=30d&agentId=<id>&groupBy=rootSession`: the spend is
  the Usage page's (credits charged plus the list-price estimate of usage paid
  by plans or your own keys), a run is one root chat, and workers count toward
  their root chat's agent. Only usage the viewer can see in Usage counts;
  others' Only me chats stay in their private amounts. Without access, on an
  older server or on an error it shows nothing. Insights > Usage also groups
  and filters by **Agent** (see insights-raw-usage-api.md).
- Form: icon, name, what it helps with, Instructions, **Remember across
  chats** (a switch, on for a new agent), **Starts when** (new agents only:
  the common triggers as switches, all off; those switched on are added after
  the agent is created, and any that need setup are named in the success
  message) and who can use it: Only me, people
  in the workspace, or anyone in the organization (offered for an
  organization's workspaces, chosen only by an organization admin, with a hint
  saying what it opens). Only the name is required. Lengths are checked on save with a count
  near each limit, never cut while typing. **Only me** is off with a reason
  where Only me chats aren't available.
  A new agent starts with three short working rules as its Instructions
  (`NEW_AGENT_DEFAULT_INSTRUCTIONS`) and Can use that asks before merging a
  GitHub pull request (`NEW_AGENT_DEFAULT_TOOL_PERMISSIONS`); Skills start
  empty. API creates keep their own defaults (empty).
- Composer: an agent chip ("Opengeni ▾" with a **Chat with** list and
  **Browse agents**) sets `?agent=<id>`; `?botTemplateId=` still works. The
  agent is selected and the composer is left as it is (empty for a new chat);
  the chat starts with `agentId` (`app/lib/composer-agent.tsx`). Send waits
  while the agent loads; an agent that failed to load, or an Only me agent
  where Only me chats aren't available, shows why on the chip and blocks Send.
  An Only me agent makes the chat Only me (Workspace is
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
5. Contract, once step 3 is the previous release: point the
   legacy foreign keys at `agent_slack_installs`, stop writing the legacy
   tables, drop the sync triggers and allow several Slack installations per
   agent.
6. Legacy drop (this step), once the contract is the previous release: drop
   the legacy tables and functions and the per-agent keys, require the
   installation workspace, read Anyone in the organization only from the
   agent, and join every First message into the Instructions.

## Console agents

A Console agent (an organization agent) belongs to an organization, not to a
workspace. A product that embeds Opengeni sets it up once and every chat that
names it runs it, in any workspace the organization manages. Its settings
live in numbered, immutable versions: Instructions plus the model, built-ins,
tool servers (organization MCP servers referenced by key), which of their
tools are on, which ask first, and whether workers get the Instructions. One
version is published; new chats run it, and each chat stays on the version
it started on until a publish moves it.

Contracts: `packages/contracts/src/organization-agents.ts`. Tables and the
visibility rule: migrations `1505`–`1509`. Agents in this section are separate
from the workspace agents above: `agentId` on session create keeps naming a
workspace agent and never an organization agent.

### Three setups

- **Console agent** (`managedBy: "console"`): created, edited, saved as a
  draft, tested, published and rolled back in Console.
- **Code agent** (`managedBy: "code"`): one YAML file per agent,
  `agents/<key>.yaml`, deployed with `npx opengeni agents deploy <dir>`, the
  [GitHub Action](../actions/agents-deploy/README.md) or
  `PUT /v1/organizations/:organizationId/agents/by-key/:key/apply`. Console
  shows it read-only as "Managed by code". A deploy is idempotent: the config
  hash (`sha256:` of `canonicalOrgAgentDefinitionJson`) of a definition that
  matches an existing version reuses that version. An organization owner can
  move a code agent to Console management (audit-logged); after that, code
  deploys get 409 `agent_managed_in_console`. Console's **Export as YAML**
  writes a Console agent's file and its Markdown instructions.
- **No agent**: a chat that names no organization agent takes exactly
  today's code path, with the same session row and prompt.

### The agent file

```yaml
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/opengeni/schemas/agent.schema.json
key: support
name: Customer support
description: Answers customer questions.
instructions: ./support.md
model: gpt-5.5
toolServers:
  - server: helpdesk
    tools: { mode: selected, enabled: [search_articles, create_ticket] }
    approval: { ask: [create_ticket] }
    newTools: off
workers:
  shareInstructions: false
runsOn: { kind: sandbox }
```

`key` must match the file name. `instructions` that name an existing `.md`
file next to the YAML file are read from it; any other value is the
Instructions text. The JSON Schema ships in the `opengeni` npm package
(`schemas/agent.schema.json`) and is generated from `OrgAgentFile`
(`bun scripts/generate-agent-file-schema.ts`); the header line above gives
editors completion and checks. The full reference is
[Agents as code](../docs-site/integrate/agents-as-code.mdx).

`opengeni agents deploy <dir>` checks every file first and deploys nothing
while any has a problem, then prints one line per agent: key, outcome
(`created`, `updated`, `unchanged`), version, whether it is published, and
the config hash. A missing instructions `.md` file is an error. `--dry-run`
writes nothing, says `would create vN` or `unchanged` for each agent and
prints its diff against its published version,
`--publish` publishes the
deployed version, `--move-running-chats` (with `--publish`) also moves
running chats. It reads `OPENGENI_API_KEY` (an organization key with
`agents:manage`), `OPENGENI_ORGANIZATION_ID` (or `--organization`) and
`OPENGENI_BASE_URL` (default `https://app.opengeni.ai`).
`opengeni agents export <key> [--out <dir>]` writes an agent's YAML file.

### Naming an agent in a chat

Session create takes `agent: "<key or id>"`, or `agent: { ref, ... }` where
the other fields change settings for this chat only:

- `model` and `reasoningEffort` (top level), `capabilities`, `identity`,
  `renderer`, `titleInstructions`;
- `instructions`: added after the agent's Instructions, never replacing them;
- `toolServers`: per server, `enabled: false` drops it, `tools` replaces the
  selection, `disableTools` turns tools off, `approval` replaces "Ask first",
  `eager`, and `headers`, the chat's own login (see Logins);
- `mcpServers` and `tools` add servers as today;
- `version`: pin the version to run. In the organization's Console test
  workspace any version can run, drafts included; everywhere else only the
  published version is accepted, and another number answers 404
  `agent_not_found`;
- `config`: an inline code-agent definition; each distinct config becomes a
  version of a code-managed agent.

Changes to the agent's own tool servers may only narrow what the agent gives:
turn servers or tools off, choose fewer of its tools, or ask first for more of
them. Turning on tools the agent left off, taking "Ask first" away, replacing
one of its servers through `mcpServers`, and saving a `config` need
`agents:manage` for the organization: an organization key holding it (whose
workspace scope includes the chat's workspace), or the organization's owner or
an admin. A workspace role never counts. Otherwise the create fails with 403
`agents_manage_required`. Servers a chat adds under a new id need
`mcp_servers:attach`, as for any chat. Inline saves are recorded in Console's
audit log (`agent.created`, `agent.version_saved`). Without `agents:manage`, a
`config` that matches a saved version runs only when that is the published
version (any version in the Console test workspace); otherwise 404
`agent_not_found`. After create, changing "Ask first" for one of the agent's
servers (`PATCH .../mcp-servers/:serverId/approval-policy`) follows the same
rule: asking first for more is allowed, asking for less than the agent needs
`agents:manage` (403, `details.code` `agents_manage_required`). On that route
an end user acting through the organization key (the external actor header,
as the session proxy forwards the browser) never holds the key's
`agents:manage`; the product's server, sending the same key without an actor,
does. At create the key's `agents:manage` still counts for its end users,
since the session proxy takes the agent and its overrides only from the
host's `createSession` hook.

What a chat changed is stored per session (`sessions.agent_overrides`,
`{setting: {agent, chat}}`), returned as `Session.orgAgent.overrides`, and
shown in Console as "Changed by this chat" with a diff. `agentOverrides:
"reject"` makes a create that would change anything fail with 422
`agent_override_rejected`.

Refusals use the session create envelope: `code` is
`SESSION_CREATE_FORBIDDEN` (403) or `SESSION_CREATE_REJECTED` (404, 409,
422), and `details.code` names the reason, for example `agent_not_found`,
`agent_not_published`, `agents_manage_required` or `agent_override_rejected`.

The session proxy (`@opengeni/sdk/session-proxy`) drops an organization agent
(`agent` as a string or with `ref`) and `agentOverrides` sent by the browser;
the host names the agent from its `createSession` hook.

### Tool servers and logins

New tools a server starts offering after a version was saved are off unless
the version's `newTools` is `on` or `on_with_approval`. A `per_user` tool
server's login comes from, in order:

1. the organization's credential provider (`credentials.request` with the
   server in `mcpServers`, as today);
2. the end user's stored login,
   `PUT /v1/workspaces/:workspaceId/end-users/:externalUserId/tool-credentials/:toolServerKey`
   (headers or OAuth, encrypted, refreshed before expiry, never readable back);
3. the chat's own `headers` for the server, only for a turn its creator or
   its end user started, or no person started (an API key, a schedule, a
   worker); another person's turn needs their own login.

A `per_user` server never falls back to a shared key. Without a login the
chat runs without that server and records `session.tool_server.unavailable`.

Each turn checks that the agent is not archived and still reaches the chat's
workspace (a managed workspace, or one the agent was added to). If not,
existing chats lose the organization's secrets from the next turn: shared-key
servers and stored end-user logins are unavailable (`missing_credentials`),
while the credential provider and the chat's own headers still apply.

Stored secrets stay with the origin they were given for. Changing a tool
server's URL to another origin drops its shared key (unless the same request
sets a new one) and deletes every end user's stored login for it; changing the
OAuth token URL to another origin (or adding one) drops the client secret
(unless re-supplied) and deletes the stored OAuth logins. The audit row says
what was dropped. Removing an end user from a workspace deletes their stored
logins there; offboarding them from the organization deletes their logins in
every workspace and the display name and email the product sent.

Tool server writes and publishing with `moveRunningChats` reach every
workspace of the organization, so an organization key limited to selected
workspaces gets 403 `organization_key_workspace_limited` for them.
Such a key sees only its own workspaces in an agent's `workspaceIds`, and a
`PATCH` with `workspaceIds` changes only those: the agent's access in other
workspaces stays as it is. Other callers replace the whole list.

### Runs on

`runsOn` says where an agent's chats run:

- `{ kind: none }`, **No computer**: tools and API only; the chat is created
  with `sandboxBackend: "none"`.
- `{ kind: sandbox, environment? }`, **Cloud sandbox**: each chat gets its own
  isolated sandbox from the deployment's cloud backend, optionally built from
  an organization Sandbox Environment (name or id). Refused with 422
  `runs_on_unavailable` on a deployment without a cloud backend.
- `{ kind: machine, machine }`, **Organization machine**: every chat runs on
  one organization Connected Machine (name, machine id or sandbox id), shared
  by all chats of all end customers.

Omitted `runsOn` keeps today's placement for the workspace (its default
machine, else a cloud sandbox). Console suggests Cloud sandbox when the
built-ins that use a computer (Browser or Workspace files) can be on, else No
computer (`suggestedOrgAgentRunsOnKind`); the suggestion is never applied on
its own.

The machine or environment must be an organization one whose reach includes
the workspaces the chats run in: **All product-managed workspaces**
(`allowManagedWorkspaces`, migration 1512), which also covers managed
workspaces created later and the Console test workspace. Every shared
workspace alone doesn't count. Saving or deploying a version
refuses a name that matches no organization machine or environment (422
`machine_not_found` / `environment_not_found`); Personal (Only me) and
workspace machines are never listed, so naming one is refused too. Reach is
checked when a chat is created (422 `runs_on_unavailable`), because it can
change after a version is saved. `GET /v1/organizations/:organizationId/agents/compute`
lists the organization machines and environments with
`worksInManagedWorkspaces`.

A saved version keeps the machine or environment it named by id
(`agent_revisions.runs_on_target`, migration 1512), and its chats use that id.
Renaming the machine, or adding another with the same name, neither moves nor
breaks the agent. If it is removed, chats look the written name up again
(for example the same machine connected again), and refuse with
`machine_not_found` / `environment_not_found` when nothing matches. `runsOn` keeps what
was written, so the config hash and an exported YAML file stay as they were.

A create may still pass `sandboxBackend`, `targetSandboxId` or `rigId` for one
chat; the request has the final say, recorded as the `runsOn` override, and
the usual machine-access and reach checks apply. Workers a chat starts share
its computer unless they ask for their own (`sandbox: "new"`).

A Personal (Only me) machine never runs an organization agent chat. This is
checked where the chat finally lands, whatever placed it there: the request's
`targetSandboxId`, a default, or the parent's machine a worker joins (422
`personal_machine_not_allowed`). A person's own default machine ("Your default
machine") is not used for these chats; they follow the agent's Runs on, else
the workspace default. A machine the caller can't read is refused as well (422
`runs_on_unavailable`).

### Workers, publish and moves

Workers a chat starts inherit its tools, approvals and logins; they get the
agent's Instructions only when `workers.shareInstructions` is on. Publishing a
version (or an older one, a rollback) changes what new chats run.
`moveRunningChats` also moves chats on other versions; a moved chat gets the
new Instructions as a history item at its next turn
(`sessions.agent_prompt_version` trails `agent_version` until then).
The publish operation is `pending` until the move runs. When the move cannot
start, the version stays published and the operation is `failed` with
`failureReason`: `move_unavailable` (the deployment has no move workflow),
`move_start_failed` (publish again to retry) or `superseded` (a later publish
came before it started).
If the API stops between saving a publish and starting its move, the
operation stays `pending` until someone who may publish (Editor or Full, or a
key with `agents:manage`) lists the agent's publish operations more than two
minutes later: the listing starts the move again (starting is idempotent).
When the start fails it stays `pending` for the next listing; only a
deployment without a move workflow marks it `failed` (`move_unavailable`).
Viewers' and read-only keys' listings only read. A later publish also ends
it as `superseded`. A move that was already running when a
later publish took over ends `succeeded` with `failureReason: superseded`;
its counts show what it moved before it stopped.

### Access and rollout

Permissions `agents:read`, `agents:manage` and `tool_credentials:write` (in
full organization keys). Organization agents have no home workspace; a
database rule hides them from Slack, Teams and app agent lists, and from the
previous release. The feature is per organization and off by default:
`OPENGENI_ORG_AGENTS_ACCOUNT_IDS` lists the accounts that have it. The
Console test chat runs in a per-organization test workspace
(`organization_managed_workspaces.source = 'console_test'`) as the tester's
own test chat principal; nobody is a member of that workspace, and only the
tester reads and continues their test chats, through the `test-chats` routes
([Console roles](opengeni-console.md#roles)). Test chats reach only their own
chat tree (`agentAccess: "session"`), keep no Memory, and their pasted logins
run only for turns the tester's own principal started.

### How Console agents are stored

Console agents (organization agents) are agents an organization defines once
and uses across its workspaces, edited in Console or deployed from code. They
are on per organization (`OPENGENI_ORG_AGENTS_ACCOUNT_IDS`, see
[deployment](deployment.md)); routes are listed in [`http-api.md`](http-api.md).

- Data (migration 1505): an `agents` row with `scope = 'organization'`, no
  home workspace, an `agent_key` unique in the organization,
  `published_revision` and `managed_by` (`console` or `code`). Each version is
  one immutable `agent_revisions` row with `config`, `tool_catalog`, `source`
  and `config_hash` (`sha256:` of `canonicalOrgAgentDefinitionJson`); saving or
  deploying a definition whose hash matches any version reuses that version.
  Publishes and rollbacks are rows in `agent_publish_operations` (a version's
  "published at" comes from them). `agent_workspace_access` lists workspaces
  besides the organization's managed ones where the agent is available.
- Visibility: a restrictive policy hides organization rows unless the
  transaction sets `opengeni.org_agents_v1`. Only
  `packages/db/src/organization-agents.ts` (and the turn worker's reads) set it,
  so Slack placement, Teams routing and the app's agent lists never see them.
  This is not authorization: every route checks permissions first.
- Who: organization keys with `agents:read`, `agents:manage` and
  `tool_credentials:write` (full organization keys hold them through
  `workspace:admin`; explicit keys get `agents:read` from a `:read` preset), and
  the organization's people by Console role: owners and admins everything,
  Editors read and edit Console-managed agents (test chats, publish) except
  ones available in team workspaces (403 `agent_in_team_workspaces`), Viewers
  read, other members nothing (see
  [Console roles](opengeni-console.md#roles)). Only an owner (never a key) switches an agent between Console and
  code management; afterwards Console edits of a code agent answer 409
  `agent_managed_by_code` and deploys to a Console agent 409
  `agent_managed_in_console`.
- Tool servers (`organization_tool_servers`) are referenced by key in versions.
  A shared key and an OAuth client secret are stored encrypted and never
  returned. End users' logins (`end_user_tool_credentials`) are stored per
  managed workspace and end user (`external_user:<id>`), encrypted, write-only;
  a workspace context sees its own, the account context all of the
  organization's (to delete them across workspaces when a server moves to
  another origin or an end user is offboarded, see
  `packages/db/src/end-user-tool-data.ts`).
- Every write records a Console audit row (`agent.*`, `tool_server.*`,
  `tool_credential.*`).
- Drafts run only in the organization's Console test workspace
  (`organization_managed_workspaces.source = 'console_test'`), created by
  `POST .../agents/test-workspace`.
