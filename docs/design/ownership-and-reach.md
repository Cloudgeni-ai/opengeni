<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Ownership, reach and management

Status: decided 2026-10-30, built incrementally (see "Build order"). This
record states the end state for every kind of resource, so individual fixes
stop deciding ownership questions one at a time.

## Rules

1. **Places.** A deployment holds organizations. An organization holds
   shared workspaces and one Personal workspace per member. Nothing crosses
   organizations. A Personal workspace differs from a shared workspace only
   in that nobody but its owner can be in it.
2. **One owner per thing.** Every resource (subscription account, model API
   key, integration and its logins, vault, machine, rig, Skill, Knowledge,
   browser identity, file, chat, schedule) is owned by exactly one of: the
   organization, one workspace, or one person (an organization membership).
   Where it is added decides the owner.
3. **The owner decides who manages it.** Organization things: organization
   owners and admins. Workspace things: that workspace's admins and
   organization owners and admins. A person's things: only that person.
   Administrators can keep a person's things out of shared workspaces by
   policy, but never open, edit or take them.
4. **Reach is separate from ownership.** One "Who can use this?" setting with
   the same words on every kind: Only me, This workspace, Selected
   workspaces, All workspaces, plus "workspaces created by this app" for
   embedding products and a per-item switch for Personal workspaces.
   Sharing never changes the owner; moving a thing to another owner is an
   explicit action by someone who manages both sides.
5. **Only me things** reach their owner's Personal workspace plus the
   workspaces where the owner turned them on. A new Only me thing starts in
   the workspace where it was added. Personal Skills follow their owner
   everywhere, because they carry preferences rather than access.
6. **A shared workspace's things never reach anyone's Personal workspace**,
   and a Personal workspace's own things never leave it.
7. **Every turn belongs to one person**: the sender when known, otherwise
   the schedule's owner. Continuations, retries, child agents and wake-ups
   keep that person. A turn started by an API key or an ownerless automation
   has no person.
8. **A turn uses** what reaches its workspace, plus its person's own things
   turned on there, and nobody else's. Using your own things on your own
   turn needs no per-chat grant and no Allow card. In a shared chat, the
   owner sees one line above the message box while their own login or
   machine works for their messages there ("This chat runs on your personal
   machine "Laptop". People in this workspace see what the agent does on
   it."), with a way to stop or move off it. Only the owner sees it, and it
   never blocks. Other own things get no line: a plan, secrets and Skills
   show others nothing of the owner's, a browser is used only when asked for
   in that chat, and Knowledge, files and meetings reach only where their
   own setting puts them. If one of your things is not on in this workspace
   yet, the agent asks once per item per workspace, never per chat.
9. **Schedules run as their owner**, shared schedules included. A schedule
   uses a personal machine only when that machine was picked on it, never
   through a workspace default.
10. **Approval choices belong to the login** and follow it between
    workspaces; only its owner sets a personal login's choices. A workspace
    limits a login by whether the connector is on there and which of its
    tools are enabled, not by choices of its own.
11. **Money.** The organization is the only wallet. A model line in the
    picker is one kind of payment (subscription, API key or credits). Within
    the kind, the account is chosen: the turn person's own (where turned
    on), then the workspace's, then the organization's; an administrator
    can pin one. Exhausting one kind never falls back into credits.
12. **Ceilings.** Deployment, then organization, then workspace, then person.
    A lower level can only narrow what a higher level locked. A workspace
    model allowlist narrows the organization's; it never replaces it.
13. **Privacy.** Administrators never open anyone's Only me chats, files or
    schedule contents.

## Decisions

| ID | Decision | Accepted cost |
| --- | --- | --- |
| OR-1 | Organization admins can do everything an owner can, except billing and plan, changing owners, and deleting the organization. Finer roles come later as custom roles. | More people can change organization-wide things. |
| OR-2 | A workspace's thing shared with other workspaces stays that workspace's. Its admins and organization admins manage it; other workspaces can use it or remove it from themselves, but not edit it. Sharing needs admin rights in both workspaces. Supersedes the "making it serve more workspaces makes it the organization's" clause of D-50 in `docs/subscription-accounts.md` once built. | One team depends on a thing another team controls. |
| OR-3 | A turn its person starts in a shared chat uses that person's own subscription first, in workspaces where they turned it on, without picking it per chat. | Shared work uses up the person's own limits; alternating senders switch accounts and miss the prompt cache. |
| OR-4 | Cross-provider failover between subscriptions of the same tier is on for new organizations, never into credits (answers Q-02). Q-04: same tier only. Q-06: use the pin. | The model changes mid-chat and the prompt cache is lost. |
| OR-5 | Organization credential providers get a per-provider "Personal workspaces" switch, off by default. Organization webhooks never reach Personal workspaces. | A webhook sends each workspace's events, with their content, to an outside address; letting it into Personal workspaces would expose private work, so people who want that wire their own. |
| OR-6 | An optional monthly cap per person for Personal-workspace spending, off by default. | One more limit for administrators to understand. |
| OR-7 | "Who may add" stays with existing controls: workspace roles and custom permissions, the organization integration policy, and the organization switches. One new organization switch, "Members connect their own machines", on by default. Embedding products need none, because people added through an app's API act only inside their own workspace. | No per-kind "who may add" matrix. |
| OR-8 | Documents, spreadsheets, presentations and projects can be Only me, like chats. An Only me project holds only its owner's Only me chats and Sites and can be shared with the workspace later, never the other way. | Two visibilities to explain on more kinds. |
| OR-9 | Three overviews: My things (account menu and Settings under Your account), Available here (workspace settings) and Shared (organization settings), built in that order. | Three more pages to keep consistent with each kind's own page. |
| OR-10 | Skills and Knowledge shared with selected workspaces separate "use" from "manage", and follow the organization admin permissions (OR-1). Organization-level integrations are designed first and built after the overviews. Only me saved browser logins belong to the browser area and follow rule 5 there. | These wait behind other work. |
| OR-11 | Organization owners and admins add an MCP connector once and choose which workspaces it reaches. Each person signs in with their own login, or the organization supplies one key. A workspace's own setup of the same connector wins, and its admins can turn the organization's off there but not edit it. See "Organization integrations". | A workspace depends on the organization's setup unless it adds its own; an organization key's calls look the same to the provider whichever workspace made them. |

## Organization integrations (OR-11)

- **Adding.** In Organization settings → Integrations, an organization owner
  or admin adds a catalog connector or a custom MCP server URL, with the
  common "Who can use this?" setting: all or selected shared workspaces, plus
  a Personal workspaces switch that starts off. The organization integration
  policy still applies, when it is added and whenever it is served.
- **Logins.** One of two. *Each person signs in*: nothing is shared; each
  person's own login works where they turned it on (rule 5), and the first
  use in another reached workspace asks once. *Organization key*: request
  headers, such as an API key, stored encrypted on the organization's
  setup, never shown again and sent only to that server; every turn in a
  reached workspace uses it.
- **In a workspace.** The connector is listed once, marked as coming from
  the organization. The workspace's own setup of the same connector, on or
  off, wins. Turning the organization's connector off there stores a
  turned-off setup for that workspace; turning it back on removes it.
  Workspace admins can't edit the organization's settings or see its key.
- **Limits and choices.** Organization admins choose which tools are on,
  everywhere it reaches. A personal login's tool choices follow the login
  (rule 10). With an organization key, each workspace's connector managers
  set choices for that workspace, starting from the organization's
  recommendations.
- **What agents see.** A workspace's enabled connectors include the
  organization's that reach it, with the same server IDs and name order as
  if the workspace had added them itself, so the tools look the same either
  way and nothing earlier in a chat changes. A person's own logins carried
  into their Personal workspace include connectors that reached the
  workspace where the login was made.
- **Not yet.** API Integrations and plugins (their install model is per
  workspace), one organization-wide OAuth login shared by everyone
  (connections can't be owned by an organization; a workspace that wants a
  shared login adds the connector itself), and "workspaces created by this
  app".

## Changes from the tree on 2026-10-30

- Organization admin permissions (OR-1) are being widened kind by kind.
- Subscription accounts lose their owner when shared beyond their workspace,
  and the Claude catalog still derives a per-workspace "pool" from that
  owner marker, so Claude models can vanish where accounts serve. Fix: one
  readiness rule shared by the catalog, admission and placement, Claude
  model IDs without the pool prefix (old IDs stay aliases), and OR-2.
- Personal machines need a per-chat grant on their owner's turns in shared
  chats, and shared schedules cannot use them. Fix: rules 8 and 9.
- Reach controls exist per kind with different words; organization-level
  integrations, sharing with selected workspaces for machines, Skills and
  Knowledge, Only me documents and projects, merging duplicate personal
  logins made before reuse existed, and approvals that follow the login
  are missing.
- Organization credential providers skip Personal workspaces (OR-5).
- A workspace model allowlist replaces the organization's instead of
  narrowing it, and members can't be kept from connecting their own
  machines (OR-7).

## Build order

1. Organization admin permissions (OR-1).
2. One owner rule for subscription accounts (OR-2), pool-free Claude model
   IDs, and account choice within the kind of payment (OR-3).
3. Own things on own turns: no machine grant, the shared-chat notice,
   schedules with a picked machine, the one-time "use it here too".
4. The "Who can use this?" control on every kind, with owner and manager
   shown, organization-level integrations, merged duplicate logins,
   approvals that follow the login, Only me documents and projects, and the
   overviews (OR-9).
5. Personal-workspace reach for organization credential providers (OR-5);
   an optional per-person cap on Personal-workspace spending (OR-6).
6. Lockable model ceilings and the machines switch (OR-7).
7. Failover default (OR-4).
8. Documentation that contradicts the code.

Related records: `docs/design/sender-owned-connections.md` (extended by
rule 8 to machines and subscriptions) and
`docs/design/privacy-audiences-2026-10-11.md` (its per-chat machine grant
and its rule that shared schedules cannot use personal machines are
replaced by rules 8 and 9).
