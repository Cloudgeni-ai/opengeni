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
   turn needs no per-chat grant. In a shared chat the first use of each of
   them shows everyone a notice ("Using Ada's laptop (Only me)") with a way
   for the owner to stop using it there. If one of your things is not on in
   this workspace yet, the agent asks once per item per workspace.
9. **Schedules run as their owner**, shared schedules included. A schedule
   uses a personal machine only when that machine was picked on it, never
   through a workspace default.
10. **Approval choices belong to the login** and follow it between
    workspaces. A workspace administrator's "ask" or "block" stays a ceiling.
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
- Organization credential providers and webhooks skip Personal workspaces.
- A workspace model allowlist replaces the organization's instead of
  narrowing it, and "who may add" is not configurable per kind.

## Build order

1. Organization admin permissions (OR-1).
2. One owner rule for subscription accounts (OR-2), pool-free Claude model
   IDs, and account choice within the kind of payment (OR-3).
3. Own things on own turns: no machine grant, the shared-chat notice,
   schedules with a picked machine, the one-time "use it here too".
4. The "Who can use this?" control on every kind, with owner and manager
   shown, organization-level integrations, merged duplicate logins,
   approvals that follow the login, Only me documents and projects.
5. Personal-workspace reach for organization credential providers and
   webhooks; an optional per-person cap on Personal-workspace spending.
6. Lockable model ceilings and "who may add" per kind.
7. Failover default (OR-4).
8. Documentation that contradicts the code.

Related records: `docs/design/sender-owned-connections.md` (extended by
rule 8 to machines and subscriptions) and
`docs/design/privacy-audiences-2026-10-11.md` (its per-chat machine grant
and its rule that shared schedules cannot use personal machines are
replaced by rules 8 and 9).
