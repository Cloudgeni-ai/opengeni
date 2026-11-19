# Opengeni Console

Opengeni Console is the administration surface for organizations that embed
Opengeni in their own product. Organization owners and admins use it to read
what their product's end users asked and what the agent answered, see the
metered cost, create organization API keys and choose how much of their end
users' sessions they review; members they give a Console role (see
[Roles](#roles)) read or edit within it. It is served by the web app under `/console`
with the app's account, sign-in and organization switcher, and has no chat
sidebar.

## Its own host

Console is also a separate platform on its own host: `console.opengeni.ai` in
production and `staging.console.opengeni.ai` on staging. The web app treats a
host whose first or second label is `console` as a Console host
(`apps/web/src/lib/console-route.ts`); `consolex.*` and `app.*` are not. On a
Console host:

- every app path opens a Console page: `/` opens Overview, organization
  settings sections open their Console page (People → Members, Billing and
  Insights → Usage and billing, Developer → API keys, General → Settings), and
  workspaces or chats open Overview. Sign-in returns, password reset, account
  setup, shared chats and other fixed public pages keep their path.
- signing in continues with the person's Opengeni account on the app host
  (see [Signing in](#signing-in)); Console's own email and Google sign-in,
  sign-up, password reset and email verification stay available as a fallback,
  and post-sign-in, Google sign-in and invitation links return to the Console
  host.
- Members (invite, roles, remove), Usage and billing (top-ups, plans, budgets,
  Stripe returns), API keys and the organization name work inside Console with
  the app's organization settings pages. End users (`external_user:`) are
  never listed as members.
- the account menu has Sign out, and nothing links into the app.

The API takes the host a link should open on from the request: an allowed
`x-forwarded-host` (`OPENGENI_BETTER_AUTH_ALLOWED_HOSTS`), else
`OPENGENI_PUBLIC_BASE_URL`. That chooses the host of verification emails,
invitation account-setup links (a resent invitation keeps the host it was
first sent from), Google sign-in returns and the Stripe return
pages Console asks for.

A deployment serving Console on its own host sets:

| Setting | Value |
| --- | --- |
| `OPENGENI_BETTER_AUTH_ALLOWED_HOSTS` | the app and Console hosts, e.g. `app.opengeni.ai,console.opengeni.ai` |
| `OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS` | both origins, e.g. `https://app.opengeni.ai,https://console.opengeni.ai` (browser mutations, passkeys) |
| `OPENGENI_BETTER_AUTH_COOKIE_DOMAIN` | optional: the shared parent, e.g. `.opengeni.ai`, so one sign-in covers both hosts. Unset, each host keeps its own host-only sign-in (same accounts and organizations); everything above works on the Console host either way |
| `OPENGENI_BETTER_AUTH_COOKIE_PREFIX` | optional; a distinct prefix (e.g. `opengeni-staging`) keeps staging's cookies apart from production's on a shared parent domain. Unset keeps Better Auth's default name, so existing sessions stay signed in |
| Google OAuth client | add `https://<console host>/v1/auth/callback/google` as a redirect URI |

The web server proxies `/v1` with the incoming host as `x-forwarded-host`, and
its Content-Security-Policy uses `'self'`, so no other change is needed there.
Passkeys are bound to the hostname they were made on: a passkey made on the
app host does not sign in on the Console host (one made there does, with the
Console origin in `OPENGENI_BETTER_AUTH_TRUSTED_ORIGINS`). A GitHub OAuth app
has a single callback host, so Console's own sign-in offers Google and email,
not GitHub. Signing in through the app host (below) covers every method,
GitHub and app-host passkeys included.

## Signing in

With host-only cookies (`OPENGENI_BETTER_AUTH_COOKIE_DOMAIN` unset), Console
keeps its own session but never asks for a second sign-in. A person signed out
on a Console host goes to the app host (`OPENGENI_PUBLIC_BASE_URL`) and back:

1. Console's `GET /v1/console-sign-in/start?return=<console path>` keeps a
   random verifier in a host-only `HttpOnly` cookie
   (`__Host-<cookie prefix>.console_sign_in`, ten minutes) and redirects to the
   app's `/console-sign-in` page with the verifier's S256 challenge.
2. On the app host, the app's ordinary sign-in runs first when needed (email,
   Google, GitHub, passkeys). Signed in, the page calls
   `POST /v1/console-sign-in/authorize` (same-origin, cookie only), which
   issues a single-use code bound to the person, the app session, the
   challenge, the Console origin and the return path. Only a hash of the code
   is stored (Better Auth's verification table), for sixty seconds.
3. The browser lands on Console's `GET /v1/console-sign-in/callback?code=`,
   which consumes the code atomically, checks the cookie's verifier against
   the challenge and the Console origin it reached, requires the approving app
   session to still be live, and creates Console's own Better Auth session
   through the ordinary session hook (allowed addresses, canonical identity
   and login-binding status). Console's session keeps the app session's sign-in
   time, so changes that ask for a recent sign-in still do, and its passkey
   confirmation for admin step-up, since a passkey made on the app host can't
   confirm on the Console host. A Console session the browser already had is
   ended. Then it returns to the Console page, `?org=`
   included.

Codes only go to Console origins: trusted origins and allowed hosts whose
host is a Console host, never the app's own, and only over https when the app
is https. Only the app host issues codes, at most twenty a minute per person. Return paths are relative
`/console` paths; anything else returns Overview. Every completed or refused
redemption is written to `audit_events` as `auth.console_sign_in_handoff`
(no organization or workspace; the outcome, the reason for a refusal, the
Console origin and both session ids, never a code or token).

Console's Sign out ends only Console's session and opens Console's signed-out
page, which waits for Continue instead of signing straight back in. A handoff
that fails comes back with `?console_sign_in=failed`, and a signed-out page
reached again within a minute of a handoff waits for Continue too, so sign-in
can't loop. To sign out everywhere, sign out of the app as well. An invitation
being accepted, a Console sign-in result (`?error=`) and deployments using
browser login session sets (`dual` or `broker`, `?console_sign_in=unavailable`)
show Console's own sign-in.

## Managed workspaces

A workspace is **managed by the product** when an organization API key created
it (`POST /v1/workspaces` or `PUT /v1/workspaces/external` with an
organization key). The API marks it in `organization_managed_workspaces` with
the creating key. Migration 1377 backfilled existing shared workspaces from
their creation provenance: an `api_key:` owner membership, a key-created
organization workspace lifecycle event, or an external identity
(`externalSource`) set by an SDK integration. Opengeni's own sources
(`opengeni:*`, such as an added organization's default workspace) do not count
on their own. Personal workspaces are never managed. An owner or admin can mark or unmark a shared workspace in Console;
each change is audited. Every other shared workspace is a **team** workspace.

The main app shows managed workspaces exactly as before.

## Who may review what

| Reader | Allowed |
| --- | --- |
| Organization owner or admin (a person, `holdsOrganizationAdministration`) | All of Console, under the review level |
| Organization member with a Console role, signed in as themselves | Their role's pages (see [Roles](#roles)), under the review level |
| Organization member without a Console role | Nothing in Console (`403`) |
| Any API key, including a full organization key | Nothing in Console (`403`) |
| A product's end user (`external_user:`) | Nothing in Console (`403`) |

Within Console, for an owner, admin, Viewer or Editor:

| Session | Managed workspace | Team workspace |
| --- | --- | --- |
| Shared session | Listed and readable | Cost and counts only |
| Private session of a product end user (`external_user:` owner) | Listed and readable | Cost and counts only |
| Private ("Only me") chat of an Opengeni account | Never shown | Never shown |
| Sub-agent session | Not listed; its cost counts toward its root session | Cost only |
| Site visitor conversation | Never shown | Never shown |

Personal workspaces are never listed. Reads run as the system sees the tenant
(no session actor) under the ordinary workspace tenancy RLS, and the
reviewable-session predicate is applied in SQL on every list, detail and
transcript read (`packages/db/src/console.ts`). Console reads never write
session data. Thumbs ratings, which are otherwise readable only by their
author, are read through the `console_review_read` policy on
`feedback_submissions`, which admits SELECT only inside Console's review scope
(`opengeni.console_review`), still bounded by workspace tenancy and session
visibility.

## Review level

An organization setting, `organization_session_review_settings`:

- `full` (default, no row): titles, opening messages, transcripts and rating
  comments.
- `metadata`: who, when, status, turns, ratings, tokens and cost; no titles,
  messages, comments or transcripts, and no content search (people and
  workspace names are still searchable).
- `off`: no session list or detail (`403`); Overview, Workspaces, Usage and
  API keys still work.

## Roles

Console roles are separate from app workspace roles: a Console role never
gives access to an app workspace, and a workspace role never gives access to
Console.

| Role | Who | Console |
| --- | --- | --- |
| Full | Organization owners and admins, always | Everything. Switching an agent between code and Console management is owner-only |
| Editor | A member given it | Viewer, plus creating and editing agents (including pointing "Runs on" at an organization machine or Sandbox Environment whose reach covers the workspaces the agent works in, and using the organization's tool servers), test chats (the first one creates the Console test workspace, which counts toward the workspace limit), and publishing or rolling back Console-managed agents that aren't available in team workspaces (also moving running chats) |
| Viewer | A member given it | Overview and Workspaces (names, spend and activity of every workspace in the organization, including team workspaces), Sessions with their detail and transcripts (under the review level) and cost, and Agents, versions, tool servers and an agent's sessions and usage, read-only |
| None | Every other member (default) | Nothing (`403`) |

Full only: marking workspaces managed or team, Settings (review level, audit
log), API keys, Members, Usage and billing, the organization name, tool server
writes (they hold shared keys), end users' tool logins, code deploys
(`apply`), an agent's workspaces and archiving. Editors can't create an agent
for specific workspaces or edit a code-managed one. Refusals are `403` with
`details.code: "console_role_required"`. An agent an owner or admin made
available in team workspaces runs there too, so Editors can't save drafts of
it, publish or roll it back (`403`, `details.code: "agent_in_team_workspaces"`);
Console shows it read-only for them.

An owner or admin sets a member's role on Console's Members page, or chooses
one when inviting (`consoleRole` on `POST /v1/organizations/:id/invitations`,
`none`, `viewer` or `editor`; refused for owner and admin invitations); a
Console-only invitee gets no workspace access. Only an invitation to join as
a member takes a role, chosen when inviting: to change it, revoke the
invitation and invite again (`PUT member-roles` names members only). Accepting an invitation sets the member's
Console role to the invitation's, or to none when it carried none, in the
acceptance's transaction (once: a replayed acceptance never overwrites a
later change). Changing a member's organization role or offboarding them
resets their Console role to none in the same transaction. Every role write
for a person takes a per-person lock and checks they are still a member under
it, so a concurrent offboarding is never overtaken.

Test chats make nobody a member of anything. A test chat runs in the
organization's Console test workspace as the tester's own test chat principal
(`console-test:<tester>`, a service principal holding only `workspace:read`
and `sessions:create`, `sessions:read` and `sessions:control` there, never
`workspace:admin`, so never `agents:manage`), and nobody is a member of that
workspace, owners and admins included. A tester reads and continues only their
own test chats (the ones their principal started), through `GET`
`/v1/organizations/:id/agents/:agentId/test-chats/:sessionId` (with `paused`)
and `/events?after&limit`, and `POST .../messages`,
`POST .../approvals/:approvalId` (`{ decision: approve | reject }`, answering
an "Ask first" tool call) and `POST .../control` (`{ action: pause | resume }`,
Stop and Resume), while their Console access is Editor or more; anyone
else (another Editor, an owner) gets `404`, and the app's session routes refuse
everyone without workspace access. A test chat's agent holds no more than
that principal and is created with `agentAccess: "session"` and Memory off, so
one tester's agent never reaches another tester's chats or Memory, and a test
chat's pasted logins run only for turns its own tester's principal started.
The `console-test:` prefix is the server's: an API key can't name it as a
service initiator (`422`). Losing Editor access takes test chats away
at once, with nothing to clean up. Owners and admins review test chats like any
other managed workspace's, through Console's audited session routes. An
Editor's agent can run on an organization machine whose reach the owners and
admins set, so a test chat can use that machine.

The app's People page shows "Console: Viewer" or "Console: Editor" next to
members with a Console role.

Roles are stored in `organization_console_roles` (migration 1508, one row
per member or pending invitation, FORCE RLS on the account; the runtime may
read, insert and update, never delete, and only from the account context: a
workspace context of the organization reads roles but can't write them).
Only a person signed in as themselves
(not an API key, an end user, or an agent acting for a person) holds a
Console role (`holdsOrganizationMemberConsoleStanding`). Every role change is
audited as `member.console_role_changed`, and a Viewer's or Editor's session
reads are audited exactly as an admin's. An invitation's Console role is
written in the invitation's own transaction.

## Audit log

Every session detail open writes `session.transcript_viewed` (full) or
`session.metadata_viewed` (metadata) to `organization_console_audit_events`
before the response is returned; a transcript events read writes
`session.transcript_viewed` too, unless the same reader already has one for that
session from the last ten minutes, with the reader, workspace, session and end
user. Review level changes, workspace kind changes and Console role changes
are also logged. The
runtime role may only insert and read the log. Owners and admins read it in
Console Settings.

## Cost

Cost is the metered credit the organization was charged, from the credit
ledger (the numbers billing uses): usage debits and the bring-your-own-key
platform fee. Per session, model debits are joined to the session tree's model
call facts by their idempotency keys; per workspace, organization and API key,
debits are summed by workspace. Tokens come from model call facts.

## End users

Console shows the product's own user id (`asUser(id)`) for an end user. The
API records it in `organization_end_user_labels` when it resolves an external
actor (best effort, never failing the request), and migration 1377 backfilled
existing identities. It is a label, never authority.

The product's backend may also send a display name and an email with the user:
`asUser(id, { displayName, email })`, `identity.displayName`/`identity.email` on
`addExternalWorkspaceMember`, or `displayName`/`email` from the session proxy's
`resolve`. The API stores them in `organization_end_user_profiles` (migration
1507), keyed like the labels. The latest value sent wins and a field left out
keeps its stored value. They are never rejected: names are trimmed and cut to
256 characters; an email is stored as given (trimmed), unless it has spaces or
is longer than 320 characters, which drops it. They are not part of the
identity: the same `externalId` and `source` are the same user whatever name
is sent. A `null` or non-string value is ignored. A self-hosted API from before
these fields existed rejects requests that carry them, so update the API before
the product sends them.

Console names an end user by display name, then email, then the product's id;
the id shows on hover and can be copied on the session page. Workspace names
show in full; the product sets them when it creates a workspace (`name`, or the
chat facade's `workspaceName`) and renames one with
`updateWorkspace(workspaceId, { name })` (`PATCH /v1/workspaces/:workspaceId`; the
key needs `workspace:admin`, which full-access keys have).

Search (`q`) matches the workspace name and the end user's id, name or email
at every review level, and the title and opening messages with full
transcripts.

## Agents

Organizations with Console agents turned on (`OPENGENI_ORG_AGENTS_ACCOUNT_IDS`,
off by default) get **Agents** and **Tool servers** in the Console nav. The
pages call the public organization routes
(`/v1/organizations/:organizationId/agents`, tool servers under
`agents/tool-servers`; contracts in
`packages/contracts/src/organization-agents.ts`) through
`apps/web/src/lib/organization-agents.ts`; Console has no routes of its own.
Those routes answer 404 while the flag is off, which is how Console knows.

- **Agents** lists each agent with its key, who manages it (Console or
  "Managed by code"), the published version and a waiting draft.
- An agent's **Settings** tab edits Instructions, model, reasoning effort,
  built-in tools, tool servers, workers ("Share instructions with workers")
  and the workspaces it is available in besides every managed workspace.
  Each tool server shows the tools it offers now: each tool on or off, "Ask
  first" per tool, and what happens to tools the server adds later (Off, On,
  or On, ask first). Save draft writes a new version; Publish makes it what
  new chats run. "Export as YAML" downloads `<key>.yaml`, which deploys back
  to the same config hash.
- **Test** starts a chat on the newest version in the organization's Console
  test workspace, with an optional pasted test token per tool server that
  logs in each user, and shows it with the app's message timeline. Only its
  tester sees and continues it (see Roles).
- **Versions** lists each version's source (Console, Deploy or Chat), config
  hash and creation, compares two versions (Instructions and settings), and
  publishes or rolls back. "New chats only" is the default; "Also move running
  chats" shows how many would move, and the operation's progress.
- **Sessions** lists the agent's chats with their version; "Changed by this
  chat" marks chats that added or overrode settings, and opening one shows
  each change beside the agent's value, with a link to the session.
- A code-managed agent opens read-only. An owner can switch it to Console
  management (audited); code deploys of it are refused afterwards.

Viewers see these pages read-only, and Editors can't edit tool servers (see
[Roles](#roles)).

**Tool servers** lists the organization's MCP servers (name, key, URL, login:
each user's login, a shared key, or none). Shared key headers and an OAuth
client secret are write-only. Each server shows the tools it offers now.

In the app, a workspace's Agents page lists the organization agents available
there under "Managed in Console", read-only, with "Open Console" for owners
and admins.

## API

All routes are under `/v1/organizations/:organizationId/console` and are
mirrored by `@opengeni/sdk` methods. Contracts: `packages/contracts/src/console.ts`.

| Route | SDK method |
| --- | --- |
| `GET summary?range=7d\|30d\|90d` | `getConsoleSummary` |
| `GET workspaces?range&kind=all\|managed\|team` | `listConsoleWorkspaces` |
| `PUT workspaces/:workspaceId` `{ kind }` | `updateConsoleWorkspace` |
| `GET sessions?limit&cursor&workspaceId&q` | `listConsoleSessions` |
| `GET workspaces/:workspaceId/sessions/:sessionId` (audited) | `getConsoleSession` |
| `GET workspaces/:workspaceId/sessions/:sessionId/events?after&limit` (audited) | `listConsoleSessionEvents` |
| `GET` / `PUT settings` `{ reviewLevel }` | `getConsoleSettings` / `updateConsoleSettings` |
| `GET audit-log?limit&cursor&sessionId` | `listConsoleAuditLog` |
| `GET api-keys?range` | `getConsoleApiKeyUsage` |
| `GET access` (the caller's Console role: `full`, `editor`, `viewer` or `none`) | none yet (`requestJson`) |
| `GET member-roles`, `PUT member-roles` `{ subjectId, role }` (owners and admins) | none yet (`requestJson`) |

Keys are created and revoked with the ordinary organization API-key routes
(`createOrganizationApiKey`, `deleteOrganizationApiKey`).

The session list reads the organization's 2,000 most recently created managed
workspaces and sets `truncated: true` when there are more.

## Not yet

A Console-specific
onboarding for someone who has no organization yet (they get the app's
organization setup, then land in Console), and Insights inside Console.
End-user opt-out,
content masking, hiding managed workspaces in the app, time-boxed support
access and compliance access are planned. A future compliance mode must cover
only chats created after it is turned on.
