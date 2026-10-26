# Agent profiles

Agent profiles give the agent in a chat a recognizable identity (a name, a one-line
role and a small avatar tile) and let a workspace save how an agent works so any
chat can reuse it. They are off by default behind `OPENGENI_AGENT_PROFILES_ENABLED`.

There is one ladder, and nobody has to configure anything to use the first rung:

| Level | What a person does | What is stored |
| --- | --- | --- |
| 0. Just a chat | Nothing. The default Opengeni agent. | Nothing new. |
| 1. Name it | Give this chat's agent a name and an avatar. | `sessions.agent_profile` with null profile fields. |
| 2. Save as agent | Turn a chat that worked into a reusable profile. | An `agent_profiles` row plus version 1. |
| 3. Configure | Edit the profile on its own page. | A new immutable version per change. |
| 4. Live with it | Give the agent a home chat; accept what its chats learn. | `agent_profiles.home_session_id`; `agent_profile_proposals`. |

A saved agent is two things at once, and both are first-class. It can be **one
long-running chat** (its home chat, where @mentions go and context accumulates)
and a **template for parallel chats** that each start from its current version.
Parallel chats diverge by design; what one of them learns comes back to the
shared identity only through a proposal a person accepts.

## Authority

A profile is a **preset, never a grant**. Starting a chat from a profile or switching
a chat to one goes through the ordinary session create and `PUT .../agent` paths, so
the caller's own grant, the deployment's capability limits, a parent session's
ceiling and an open goal's tool requirements all still apply. A profile that enables
a capability the applier cannot use simply resolves narrower for them.

Profiles are workspace-shared and gated like channels on session permissions:
`sessions:read` lists and reads them, `sessions:create` creates, edits, archives and
restores them, and `sessions:control` names or switches a chat's agent. Profiles are
archived, never deleted; archiving frees the name and hides the profile from pickers,
while chats that already wear it keep their frozen identity.

## Data model

Migration `0997_agent_profiles.sql` (rolling) adds:

- `agent_profiles`: name (unique among active profiles per workspace,
  case-insensitive), optional role, avatar, `config` and the current `version`.
  FORCE RLS; runtime `SELECT, INSERT, UPDATE`.
- `agent_profile_versions`: one immutable row per content change, keyed by
  `(profile_id, version)`. FORCE RLS; runtime `SELECT, INSERT` only.
- `sessions.agent_profile`: the display snapshot a chat wears
  (`{ profileId, profileVersion, name, role, avatar }`). NULL is the default agent.
  It is presentation only and never read at turn time.

`AgentProfileConfig` (`packages/contracts/src/index.ts`) holds the optional fields a
profile applies: `agent` (the ordinary session agent configuration without
`vaultPolicy`, which stays a per-chat decision), `model`, `reasoningEffort`,
`installedSkillIds` and `tools`.

An avatar is exactly one of: a single emoji, a curated icon (`AGENT_AVATAR_ICONS`) or
one or two letters, plus a hue for its low-chroma tile. The tile is a rounded square,
so an agent never reads as a person's round monogram.

## Applying a profile

**New chat.** `CreateSessionRequest.agentProfileId` expands the profile's current
version into the raw request *before* it is parsed (`packages/core/src/domain/agent-profiles.ts`).
Every field the request omits is filled from the profile and then behaves exactly as
if the caller had sent it; explicit request fields always win. A request that sends
its own `agent` replaces the profile's agent configuration entirely, and a
request-level `instructions` keeps precedence over the profile's alias. A reasoning
effort is only carried together with the profile's model. The new session wears the
profile's identity at the exact version used.

**Running chat.** `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/agent-profile`
switches a chat from its next message. The profile's agent configuration goes
through `updateSessionAgent` with the same `toolPolicyVersion` CAS as
`PUT .../agent`, its model through `setSessionModel`, and only then does the chat
wear the new identity. Skills and connector selections stay as the chat has them;
they apply when a new chat starts from the profile. A profile without instructions
leaves the chat's current instructions in place.

**Naming only.** `PUT .../sessions/:sessionId/agent-identity` sets or clears the
display identity and changes nothing else (`session.title.write`, like a rename).

## API

All profile routes answer 404 while the flag is off; `ClientConfig.agentProfiles`
tells clients whether to show the UI.

| Route | Permission |
| --- | --- |
| `GET /v1/workspaces/:workspaceId/agent-profiles?status=active\|archived\|all` | `sessions:read` |
| `POST /v1/workspaces/:workspaceId/agent-profiles` | `sessions:create` |
| `GET /v1/workspaces/:workspaceId/agent-profiles/:profileId` | `sessions:read` |
| `GET /v1/workspaces/:workspaceId/agent-profiles/:profileId/versions` | `sessions:read` |
| `PATCH /v1/workspaces/:workspaceId/agent-profiles/:profileId` (`expectedVersion`) | `sessions:create` |
| `POST .../agent-profiles/:profileId/archive` and `/restore` | `sessions:create` |
| `GET .../agent-profiles/:profileId/sessions` | `sessions:read` |
| `PUT .../agent-profiles/:profileId/home` (`{ sessionId \| null }`) | `sessions:create` |
| `GET .../agent-profiles/:profileId/proposals?status=pending\|accepted\|dismissed\|all&sessionId=` | `sessions:read` |
| `POST .../agent-profiles/:profileId/proposals/:proposalId/accept` (`expectedVersion`) and `/dismiss` | `sessions:create` |
| `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/agent-identity` | `sessions:control` |
| `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/agent-profile` | `sessions:control` |

The SDK exposes them on the opt-in `OpenGeniAgentProfilesClient` from
`@opengeni/sdk/agent-profiles` (wrap an existing client:
`new OpenGeniAgentProfilesClient(client)`), keeping them out of the eager core
client and browser bundle: `listAgentProfiles`, `createAgentProfile`,
`updateAgentProfile`, `archiveAgentProfile`, `restoreAgentProfile`,
`listAgentProfileVersions`, `updateSessionAgentIdentity`,
`applySessionAgentProfile`, `listAgentProfileSessions`, `setAgentProfileHome`,
`listAgentProfileProposals`, `acceptAgentProfileProposal` and
`dismissAgentProfileProposal`.

## Rollout

Apply migrations 0997-1000 (all rolling; 1000 is a concurrent index), deploy the API and web images that carry it, then set
`OPENGENI_AGENT_PROFILES_ENABLED=true` on the API. Turning the flag off hides the
routes and the UI and rejects `agentProfileId` on create; stored profiles and
session identities are kept.

## Web UI

All of it is hidden while `ClientConfig.agentProfiles.enabled` is false.

- **Agent tile** (`@opengeni/react/ui/agent-mark`): a rounded square holding one
  emoji, a curated icon or one or two letters on a low-chroma hue. People keep
  round monograms, so an agent is never mistaken for a person. The picker is
  `@opengeni/react/ui/agent-avatar-picker`.
- **Rail rows and chat header**: a chat that wears an identity shows its tile
  before the title, and the row's spoken name includes "Agent <name>". The header
  tile opens "Name this agent" (`agent-identity-control.tsx`): name, avatar, Save
  as reusable agent, Remove.
- **Composer agent chip** (`composer-agent-chip.tsx`): on a new chat it chooses
  the saved agent the chat starts from (and adopts its model policy in the
  picker, so the request does not override it); on a running chat it switches
  the agent from the next message. The new-chat screen also shows up to four
  agent cards ("Start with an agent"), and `?agent=<id>` preselects one.
- **Agents pages** (`apps/web/src/components/agents/`): `/workspaces/:id/agents`
  (list, archived view), `/agents/new` (new; `?fromSession=` prefills "Save as
  agent" from a chat and makes that chat the agent's first; `?draft=` carries a
  suggestion), and `/agents/:profileId` (edit, Start chat, Archive/Restore).
  `/agents/:profileId/chats` lists the agent's chats with its home chat first
  (make or clear the home chat there, or from the running chat's agent chip),
  and `/agents/:profileId/updates` reviews proposed updates; the agent's page
  links both and counts pending updates.
  The rail lists Agents only while the feature is on; the pages send people to
  the chats otherwise, as the retired Agents page did.

## Agent suggestions

`agent_profile_suggest` (first-party tool, `knowledge` family, `sessions:read`)
lets an agent propose, at most once per chat, either a new agent (choosing the
name, role, emoji and drafted instructions itself) or switching to a saved agent
that already does the work. It creates nothing: it validates the proposal (an
active name already taken returns the saved agents so the agent can suggest
reuse) and records it on the chat (`sessions.agent_profile_suggestion`,
migration `0998`, display state only), returning an `agent_profile_suggestion`
receipt. The chat shows the newest one (streamed receipt first, then the kept
copy, so it survives a reload when tool steps are not loaded) as a card: "Review and save" opens the
prefilled Save as agent page; "Switch to <name>" applies the saved agent; "Not
now" hides it for this chat. The tool is unavailable while the flag is off
(`deploymentUnavailableFirstPartyMcpTools`), and the one sentence of prompt
guidance renders only while it can be available.

## Home chat and the agent's chats

`agent_profiles.home_session_id` (migration `0999`, rolling) points at one chat
that wears the agent. Setting it requires that chat's `agent_profile.profileId`
to be the agent and the caller to see the chat; it is a pointer, not a
configuration change, so it adds no version. No foreign key: a deleted chat
leaves a stale pointer that readers treat as "no home chat" (the mention
context only carries it, and `session_send_message` still checks access).

`GET .../agent-profiles/:profileId/sessions` lists the chats that wear the agent,
newest activity first (limit 200), with the profile version each one wears.
It reads through the caller's subject RLS, so another person's private chats
never appear. Migration `1000` adds the concurrent expression index
`sessions_workspace_agent_profile_idx` that serves it.

## Learning flows back: proposed updates

`agent_profile_propose_update` (first-party tool, `knowledge` family,
`sessions:read`) lets a chat that wears a saved agent propose complete new
instructions for it after a person corrects how it should work in a lasting way.
It never changes the agent. It records an `agent_profile_proposals` row
(migration `0999`: FORCE RLS, runtime `SELECT, INSERT, UPDATE`, plus the
restrictive `session_reference_visible` policy so a proposal from a private chat
is visible only to people who can see that chat) against the version the chat
saw, and supersedes that chat's older pending proposal. Declines are typed
(`unavailable`, `no_saved_agent`, `agent_unavailable`, `unchanged`).

A person reviews a diff against the agent's **current** instructions, in the
chat (a card under the composer) or on `/agents/:profileId/updates`.
Accepting (`POST .../proposals/:proposalId/accept` with the reviewed
`expectedVersion`, CAS like `PATCH`) replaces only `config.agent.instructions`
and records an ordinary new version; dismissing marks it decided. Proposals from
parallel chats stay separate, and one written against an older version says so
in the review. Decided proposals are kept as history.

## Mentioning an agent

Typing `@` at the end of a message in a running chat lists the saved agents;
picking one writes `@Name`. On Send, each mentioned agent's name, id and role
travel as the message's `modelContext`, with a line telling the agent where to
send the work: to the agent's home chat through `session_send_message` when it
has one (so that chat keeps its context), otherwise, or when the person asks for
a separate chat, to a new child through `session_create` with `agentProfileId`. The child
starts from that agent's current version, narrowed to the parent's own
authority like any child, and shows the agent's identity. The agent-child
creation seam (`create_agent_child_session`) keeps its fixed column allow-list;
the display-only identity is written in the same transaction right after the
insert, once any private-create capability has closed.

## Planned

- Slack posting identity ("Annie · Opengeni") behind the opt-in
  `chat:write.customize` scope, frozen per Slack thread. See `docs/slack-bot.md`,
  which currently forbids that scope; changing it is part of that phase.
- The agent's tile on its turns in the timeline and on child-agent cards.
- Keyboard selection in the @mention list (today it is pointer and touch).
