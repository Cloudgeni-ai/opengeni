# Opengeni Console

Opengeni Console is the administration surface for organizations that embed
Opengeni in their own product. Organization owners and admins use it to read
what their product's end users asked and what the agent answered, see the
metered cost, create organization API keys and choose how much of their end
users' sessions they review. It is served by the web app under `/console`
(`console.<app host>` redirects there) with the app's sign-in and
organization switcher, and has no chat sidebar.

## Managed workspaces

A workspace is **managed by the product** when an organization API key created
it (`POST /v1/workspaces` or `PUT /v1/workspaces/external` with an
organization key). The API marks it in `organization_managed_workspaces` with
the creating key. Migration 1377 backfilled existing shared workspaces from
their creation provenance: an `api_key:` owner membership, a key-created
organization workspace lifecycle event, or an external identity
(`externalSource`) set by an SDK integration. Personal workspaces are never
managed. An owner or admin can mark or unmark a shared workspace in Console;
each change is audited. Every other shared workspace is a **team** workspace.

The main app shows managed workspaces exactly as before.

## Who may review what

| Reader | Allowed |
| --- | --- |
| Organization owner or admin (a person, `holdsOrganizationAdministration`) | Console, under the review level |
| Organization member | Nothing in Console |
| Any API key, including a full organization key | Nothing in Console (`403`) |
| A product's end user (`external_user:`) | Nothing in Console (`403`) |

Within Console, for an owner or admin:

| Session | Managed workspace | Team workspace |
| --- | --- | --- |
| Shared session | Listed and readable | Cost and counts only |
| Private session of a product end user (`external_user:` owner) | Listed and readable | Cost and counts only |
| Private ("Only me") chat of an Opengeni account | Never shown | Never shown |
| Sub-agent session | Part of its root session's transcript and cost | Cost only |

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
  messages, comments or transcripts, and no content search.
- `off`: no session list or detail (`403`); Overview, Workspaces, Usage and
  API keys still work.

## Audit log

Every session detail open writes `session.transcript_viewed` (full) or
`session.metadata_viewed` (metadata) to `organization_console_audit_events`
before the response is returned, with the reader, workspace, session and end
user. Review level changes and workspace kind changes are also logged. The
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
| `GET workspaces/:workspaceId/sessions/:sessionId/events?after&limit` | `listConsoleSessionEvents` |
| `GET` / `PUT settings` `{ reviewLevel }` | `getConsoleSettings` / `updateConsoleSettings` |
| `GET audit-log?limit&cursor&sessionId` | `listConsoleAuditLog` |
| `GET api-keys?range` | `getConsoleApiKeyUsage` |

Keys are created and revoked with the ordinary organization API-key routes
(`createOrganizationApiKey`, `deleteOrganizationApiKey`).

## Not yet

Organization-level agents shared across managed workspaces, end-user opt-out,
content masking, hiding managed workspaces in the app, time-boxed support
access and compliance access are planned. A future compliance mode must cover
only chats created after it is turned on.
