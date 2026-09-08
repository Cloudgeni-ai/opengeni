# Conversations created through Sites

## Behavior

- The host bridge supplies the published Site identity. Session creation records
  `_opengeniSiteOrigin: { siteId, title }` in existing session metadata. The title
  is a creation-time label; the stable Site ID is the identity.
- Origin is descriptive, not permission, project membership, or parentage.
  Opening a pre-existing conversation does not relabel it. Existing unlabelled
  sessions are not guessed/backfilled from prompts or publishing sessions.
- Ordinary browsing groups unfiled, unpinned Site-created root conversations in
  a stable Site row. Recent/working activity lifts the row using existing rail
  ordering. Counts cover the currently loaded authorized trees, like scheduled
  run grouping; opening the Site's Conversations panel provides paginated history.
- Explicit projects and pins win. Search and custom browsing remain session-first.
  The origin link remains on individual rows and in the session header regardless
  of placement. The group is presentation only: no fake session is persisted and
  no parent-control authority is introduced.
- The host Site detail page has a Conversations sheet: search, active/archived,
  refresh, and pagination. It works independently of generated Site navigation.

## API and implementation

`GET /v1/workspaces/:id/sessions?view=page&originSiteId=<uuid>` combines Site
origin with ordinary project/search/date/visibility filters before pagination.
Origin is bound into continuation cursors. Successful responses echo
`originSiteId`; the SDK fails explicitly against servers that ignore it.
The first-party `sessions_list` tool accepts the same UUID filter.

The Site-bound SDK accepts `originSiteId: "current"`; the host replaces it with
its trusted Site ID. Sandbox previews have no published identity and resolve it
to an empty history, not the entire workspace. Other session SDK calls keep their
existing behavior and authentication.

The published HTTP bridge supplies `x-opengeni-site-id` and
`x-opengeni-site-version`. The API verifies their workspace/version relationship,
then scopes creation through `withSiteSessionOrigin`. The first-party tool
gateway uses the same scope. Concurrent requests remain isolated, including
the in-memory MCP transport. Caller-provided origin metadata is discarded.
Historical versions remain valid provenance after publication/archive so normal
response-loss retries are not broken by a mutable current-version check.
Tool allowlists, authorization and ordinary approval rules are unchanged.

## Agent defaults

The Sites skill recommends a selector for this Site's conversations plus New
conversation. First Send creates one session with a retry-stable idempotency key;
thereafter the standard `SessionConversation` owns chat interaction. No project
is created just for grouping. A user may instead request a project-wide or
workspace-wide interface. These are defaults, not product restrictions.

## Validation

Cover origin stamping/concurrent isolation, actual MCP transport propagation,
host/preview binding, SQL filtering before pagination and cursor binding,
project/pin precedence, search, aggregate counts and keyboard projection.
Inspect the host sheet and origin links in the local browser before handoff.
