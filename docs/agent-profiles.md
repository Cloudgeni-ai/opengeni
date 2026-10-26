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
| `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/agent-identity` | `sessions:control` |
| `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/agent-profile` | `sessions:control` |

The SDK exposes them on the opt-in `OpenGeniAgentProfilesClient` from
`@opengeni/sdk/agent-profiles` (wrap an existing client:
`new OpenGeniAgentProfilesClient(client)`), keeping them out of the eager core
client and browser bundle: `listAgentProfiles`, `createAgentProfile`,
`updateAgentProfile`, `archiveAgentProfile`, `restoreAgentProfile`,
`listAgentProfileVersions`, `updateSessionAgentIdentity` and
`applySessionAgentProfile`.

## Rollout

Apply migration 0997, deploy the API and web images that carry it, then set
`OPENGENI_AGENT_PROFILES_ENABLED=true` on the API. Turning the flag off hides the
routes and the UI and rejects `agentProfileId` on create; stored profiles and
session identities are kept.

## Planned

- Web UI: agent tile in the rail and chat header, the composer agent chip, the
  Agents list and profile page, "Name this agent" and "Save as agent".
- `agent_profile_suggest`: during repeated work an agent proposes a new profile
  (choosing its own name, role and avatar) or switching to an existing one; a
  person accepts the card. Nothing is created without that acceptance.
- Slack posting identity ("Annie · Opengeni") behind the opt-in
  `chat:write.customize` scope, frozen per Slack thread. See `docs/slack-bot.md`,
  which currently forbids that scope; changing it is part of that phase.
