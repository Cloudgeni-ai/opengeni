# Published Sites: API reference

This is the API side of published Sites (design record:
`docs/design/published-sites-2026-10-14.md`; shared contracts:
`packages/contracts/src/site-publishing.ts`). There are three surfaces with
three kinds of caller:

- **Management** (`/v1/workspaces/:workspaceId/...`): workspace credentials,
  used by the console, the SDK and the agent tools.
- **Viewer sign-in** (`POST /v1/site-auth/authorize`): an ordinary signed-in
  Opengeni user, called by the console's authorize page.
- **Site runtime** (`/v1/site-runtime/*`): only the Site gateway, with HMAC
  signatures. It refuses Opengeni credentials.

Every route returns `404 sites_publishing_disabled` when
`OPENGENI_SITES_DOMAIN` is unset. The site-runtime routes do the same when
`OPENGENI_SITES_GATEWAY_SECRET` is unset. Errors use the normal API error
envelope, and the specific reason is in `details.code`.

The console learns about publishing from `GET /v1/config/client`, which has a
`sites` object: `{ domain, publicEnabled, publicAgentsEnabled, loginOnly,
forceNoindex }`. It is `null` when `OPENGENI_SITES_DOMAIN` is unset.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENGENI_SITES_DOMAIN` | unset (publishing off) | Sites live at `<label>.<domain>` |
| `OPENGENI_SITES_GATEWAY_SECRET` | unset | HMAC secret shared with the gateway (at least 32 characters) |
| `OPENGENI_SITES_GATEWAY_SECRET_PREVIOUS` | unset | Also accepted during rotation |
| `OPENGENI_SITES_PUBLIC_ENABLED` | `true` | Allows `public` access |
| `OPENGENI_SITES_PUBLIC_AGENTS_ENABLED` | `true` | Allows agents for signed-out guests |
| `OPENGENI_SITES_LOGIN_ONLY` | `false` | `public` means any signed-in Opengeni user, and there are no guests |
| `OPENGENI_SITES_FORCE_NOINDEX` | `false` | Forces `noindex` on every Site |
| `OPENGENI_SITES_ABUSE_EMAIL` | unset (`abuse@<domain>` shown) | Abuse contact shown in `SiteRuntimeConfig` and takedown pages; also where operator notices are emailed |
| `OPENGENI_SITES_GUEST_AGENT_HUMAN_CHECK` | `false` | A guest agent start needs the gateway's human header (recommended for public Sites with guest agents) |
| `OPENGENI_SITES_FREE_REQUESTS_PER_MINUTE_PER_VISITOR` | 120 | Free limit |
| `OPENGENI_SITES_FREE_GUEST_WRITES_PER_MINUTE` | 30 | Free limit |
| `OPENGENI_SITES_FREE_CONVERSATIONS_PER_VISITOR_PER_DAY` | 10 | Free limit |
| `OPENGENI_SITES_FREE_CONVERSATIONS_PER_SITE_PER_DAY` | 50 | Free limit, every visitor together (unlimited still stops at 10000) |
| `OPENGENI_SITES_FREE_TURNS_PER_CONVERSATION` | 20 | Free limit |
| `OPENGENI_SITES_FREE_AGENT_MICROS_PER_CONVERSATION` | 20000 | Free limit (USD micros) |
| `OPENGENI_SITES_FREE_AGENT_MICROS_PER_VISITOR_PER_DAY` | 200000 | Free limit |
| `OPENGENI_SITES_FREE_AGENT_MICROS_PER_SITE_PER_MONTH` | 2000000 | Free limit |
| `OPENGENI_SITES_CREDITS_LIMIT_MULTIPLIER` | 10 | `credits` profile multiplies the conversation and spend limits |
| `OPENGENI_SITES_REPORTS_PER_MINUTE_PER_VISITOR` | 5 | Abuse report rate |
| `OPENGENI_SITES_VIEWER_SESSION_IDLE_SECONDS` | 43200 (12 h) | Viewer session idle expiry |
| `OPENGENI_SITES_VIEWER_SESSION_ABSOLUTE_SECONDS` | 604800 (7 d) | Viewer session absolute expiry |
| `OPENGENI_SITES_HOSTNAME_HOLD_DAYS` | 30 (minimum 30) | How long a released label stays held |
| `OPENGENI_SITES_CLOUDFLARE_API_TOKEN` | unset | Edge sync (optional) |
| `OPENGENI_SITES_CLOUDFLARE_ACCOUNT_ID` | unset | KV host map (needs the token and namespace) |
| `OPENGENI_SITES_CLOUDFLARE_KV_NAMESPACE_ID` | unset | KV host map |
| `OPENGENI_SITES_CLOUDFLARE_ZONE_ID` | unset | Cache purge on takedown (needs the token) |
| `OPENGENI_SITES_HOST_MAP_TTL_SECONDS` | 300 (60 to 86400) | KV expiry of host-map records |
| `OPENGENI_SITES_WEB_RISK_API_KEY` | unset (scanner `none`) | Enables the Google Web Risk URL scanner |

Agents on Sites also need `OPENGENI_SESSION_USAGE_LIMITS_ENABLED=true`,
because each conversation is capped with a session usage limit. Without it,
agent starts fail with `403 site_agents_unavailable` and
`reason: "usage_limits_disabled"`.

## Management

The routes below sit under
`/v1/workspaces/:workspaceId/published-artifacts/:siteId/publication`. They
need Site manager authority, which is the same rule as for Site Data
managers. The Site must be shared with the workspace, not "Only me".

| Method and path | Success | Errors |
| --- | --- | --- |
| `GET` | 200 `SitePublication` | 404 `site_not_published` |
| `PUT` (`UpsertSitePublicationRequest`) | 201 when it first publishes, otherwise 200 | 403 `site_manager_required`, `site_admin_required` (limit profile, new `agent.tools`, `agent.guestTools`), `site_public_disabled`; 409 `site_not_shared`, `site_archived`, `site_suspended` (status or label change while taken down), `site_taken`, `site_held`, `site_reserved`; 400 `site_model_not_allowed`, `site_tool_invalid`, `site_invalid_request` |
| `DELETE` (unpublish) | 200 | 409 `site_suspended` |
| `POST /takedown` (`SiteTakedownRequest`) | 200 | 403 `site_owner_or_admin_required` |
| `POST /restore` | 200 | 403 `site_forbidden` when an admin (owner restoring) or the platform took the Site down |
| `GET /reports?status=` | 200 list | |
| `PATCH /reports/:reportId` | 200 | 404 `site_report_not_found` |

Every changing route (`PUT`, `DELETE`, takedown, restore, report status and
`PUT site-limit-profile`), and the `site_publication_update` tool, refuses
a request made from a Site page (403 `site_page_forbidden`) and an agent
started from a Site page (403 `site_agent_forbidden`).

Other management routes:

- `GET /v1/workspaces/:workspaceId/site-hostnames/:label?siteId=` returns
  `SiteHostnameAvailability`. It applies the label rules (reserved, blocked
  and malformed labels), then checks global uniqueness and the hold. Pass
  `siteId` to treat the Site's own label as available.
- `GET /v1/workspaces/:workspaceId/site-limit-profile` returns the workspace
  default limit profile. `PUT` on the same path sets it and needs a
  workspace admin (otherwise 403 `site_admin_required`).

Hostnames:

- If the request gives no label, the label is `suggestSiteHostnameLabel` of
  the title plus a random four-character suffix.
- Labels are globally unique across workspaces.
- Changing a label releases the old one. A released label is held from
  other workspaces for the hold period, but the workspace that released it
  may reuse it.
- Unpublishing keeps the label so that publishing again gets the same
  address.
- The label of a taken-down Site cannot change. A platform takedown also
  holds the label for the platform (`site_hostname_holds`, with no foreign
  keys, so deleting the Site or its workspace does not free it); only
  `site-takedown.ts --release-hold` lifts it.
- Deleting a Site or its workspace never frees its label at once: a
  database trigger leaves a 30-day `release` hold (kept for that workspace,
  `held` for everyone else) in `site_hostname_holds`.
- Global lookups go through a transaction-local hostname "lane" setting
  that a row-level security policy matches (the `api_keys` pattern), not a
  `SECURITY DEFINER` function. The application role only reads holds; the
  schema owner writes them (operator scripts, and the release-hold trigger,
  which runs as the owner).

Takedown:

- A takedown sets the status to `suspended` at once, actions the open
  reports, records an audit event, revokes the Site's viewer sessions,
  cancels its running agent conversations (in-flight turns and queued
  messages), writes the edge host map and purges the edge cache.
  Unpublishing and narrowing access (a narrower mode or a removed
  invitation) do the same for sessions and conversations; turning the agent
  off cancels the conversations.
- Narrowing access signs out every viewer of the Site and cancels every
  conversation, including those of viewers who keep access; they sign in
  again. The sign-out is prompt cleanup, not the boundary: every
  site-runtime request re-checks the viewer's access.
- A conversation's workspace tools are fixed when it starts and recorded
  with it. Removing a tool, or turning **Let everyone use these tools**
  (`guestTools`) off, cancels the running conversations that hold tools
  they would not get now, without signing anyone out. Such a conversation
  (also one whose viewer has since left the workspace) takes no more
  messages: `409 site_conversation_outdated`; the viewer starts a new one.
- An owner's takedown is restored by the owner or an admin; an admin's
  takedown only by an admin.
- Only the operator script can lift a platform takedown:
  `bun scripts/operator/site-takedown.ts --host <label> --operator <name> --reason "..."`
  takes a Site down (`--site-id <id>` finds it by id), and adding
  `--restore` lifts it. Opengeni has no platform-admin API. The script
  revokes viewer sessions but has no in-process session dispatch, so
  running conversations end on their caps and site-runtime refuses them
  further work.

Agent tools: `site_publication_get`, `site_publication_update` and
`site_hostname_check` call the same service with the person's authority.
The artifact tools (`artifacts_publish`, `artifacts_rollback`,
`artifacts_archive`, `artifacts_restore`) run the same publication hook as
the API routes: a published Site's generation advances, the edge resyncs,
and a version that becomes current is scanned.

## Viewer sign-in

1. The gateway sends a signed-out viewer of a `members` or `invited` Site,
   or of a `public` Site on a login-only deployment, to the console's
   authorize page with a PKCE challenge.
2. The page calls `POST /v1/site-auth/authorize` (`SiteAuthAuthorizeRequest`)
   with the person's normal app session. It returns
   `200 { redirectTo, site }`.
   - The API checks access: `members` needs a workspace member; `invited`
     needs a member or a verified email on the invite list; `public` accepts
     any user. Without managed sign-in a user may have no verified email
     (the viewer's `email` is `null`), so they cannot match an invitation.
   - `redirectUri` must be exactly `https://<that host>/_og/auth/callback`.
   - Errors: 403 `site_person_required` or `site_access_denied`, 404,
     400 and 429.
3. `redirectTo` carries a one-time code. The code is stored only as a hash.
   It lives for 60 seconds, works once, and is bound to the host, the
   challenge, the redirect URI and the person.
4. The gateway exchanges the code (`POST /v1/site-runtime/auth/exchange`)
   for a viewer session token (`SiteAuthExchangeResponse`). The session is
   stored as a hash, expires after 12 hours idle or 7 days absolute, and is
   rechecked against current access on every call.
5. `POST /v1/site-runtime/auth/logout` revokes the session.

## Site runtime

### Signature

The API verifies the signature before it trusts anything else in the
request:

- The signature is `x-opengeni-gateway-signature: v1=<base64url HMAC-SHA256>`
  of `siteGatewayCanonicalString`, over the method, the path and query
  exactly as sent, the timestamp, the SHA-256 of the body bytes, the host,
  the session token, the visitor id, the client IP and the human flag.
- The timestamp may be at most 30 seconds from the API clock.
- Either the current or the previous secret is accepted, using
  constant-time comparison.
- Requests that carry `Authorization`, `Proxy-Authorization`, `Cookie`,
  `X-Api-Key` or an external-actor header are refused.

Every signed request also carries `x-opengeni-site-body-sha256`
(`SITE_GATEWAY_BODY_SHA256_HEADER` in `@opengeni/contracts`): the lowercase
hex SHA-256 the gateway signs as `bodySha256`, which is the hash of the empty
string for `GET` and `HEAD`. The header is required, and there is no
fallback. The API checks that it is 64 lowercase hex characters and verifies
the signature from the headers alone, before reading the body. It then reads
the body under the cap, hashing it as it arrives, and refuses a body that
does not match the signed hash.

Bodies are capped before they are read: 4 MiB for JSON and 25 MiB for
`POST /published-artifacts/current/files` (the gateway's caps). A larger
body returns 413 `site_request_too_large`.

A failure returns `401 site_gateway_signature_invalid`, with
`details.reason` set to one of:

- `missing_headers`: the signature, timestamp, host or body hash header is
  absent.
- `bad_timestamp` or `skew`: the timestamp is malformed or outside the window.
- `bad_body_hash`: the body hash header is not 64 lowercase hex characters.
- `bad_signature`: no configured secret produces the signature.
- `body_mismatch`: the body read does not hash to the signed value.
- `credentials`: the request also carries app credentials.

The gateway must sign the normalized path. A path with dot segments is
normalized by the URL parser before verification, so it fails the
signature.

### Host and viewer

- **Host.** The signed host (a trailing dot is ignored) must name an active
  publication. A missing host
  returns 404 `site_not_found`. An unpublished or suspended host returns
  410 `site_unavailable` with `{ status }`.
- **Viewer, in order:**
  1. A valid viewer session token (member, invited or user).
  2. Otherwise, a guest identified by the visitor header. This needs a
     `public` Site on a deployment that is not login-only, and the visitor
     id must match `^[A-Za-z0-9_-]{16,128}$`.
  3. Otherwise, 401 `site_sign_in_required`.

  A signed-in viewer who has lost access gets 403 `site_access_denied`.
- **Rates.** Every call counts against the visitor's requests per minute.
  Guests are also counted per signed client address, at four times the
  visitor limit, so minting new visitor ids does not reset their limits;
  both must pass. IPv6 addresses count per /64 prefix (IPv4-mapped
  addresses as their IPv4 address). Going over returns 429 `site_rate_limited` with
  `{ bucket, retryAfterSeconds }`.

### Routes

| Method and suffix | Result |
| --- | --- |
| `GET /host` | `SiteHostMapRecord` for the signed host (the gateway's fallback on a KV miss), or 404 `site_not_found`. An optional `host` query must equal the signed host |
| `GET /versions/:versionId/html` | The immutable HTML of the Site's current version, or of a version a publish or rollback replaced in the last 10 minutes (pages already open), with a sandbox CSP and an ETag. 404 `site_version_not_found` for any other version, of this Site or another |
| `POST /auth/exchange` | `SiteAuthExchangeResponse`. 400 `site_auth_code_invalid` (wrong verifier, host or redirect URI, expired, or already used) |
| `POST /auth/logout` | 200 `{ revoked }`, even when the Site no longer exists |
| `POST /site/reports` | 201. Rate limited per reporter, per client address and per Site |
| `POST /tools/:method` | 403 `site_tools_unavailable` (direct tools need a person's session in the console) |
| `SITE_OPERATIONS` suffixes | Served for the viewer, as below. Anything else returns 404 `site_operation_unsupported` |

Old versions stop being served ten minutes after they are replaced, so
content removed by a new version or a rollback does not stay reachable by
version id.

Operations:

- `config.client` and `site.config` return `SiteRuntimeConfig`, including
  the abuse contact.
- `workspace.get` is minimal and carries no tenant data.
- `models.list` returns only the allowed models.
- Site Data and files run for the current Site as a published viewer, with
  the principal `user:<subjectId>` or `guest:<visitorId>` and the viewer
  role.
  - Guests follow each collection's guest rule, which defaults to `none`:
    `read`, `append`, or `own` (a guest changes only their own records).
  - Guest writes have their own per-minute limit.
  - Guests never reach files.
- `sessions.*` are Site agent conversations:
  - **Create.** A new conversation runs as the service principal
    `site:<siteId>`, through in-process dispatch with a short-lived delegated
    token.
    - It uses `agentAccess: "session"`, the publication's model,
      instructions and MCP servers, no first-party tools, and memory off.
    - The viewer is the end-user label. The Site, its title and the served
      version are recorded as the session's origin and on every turn
      (OPE-801 `SiteSessionOrigin`). The call runs inside
      `withSiteSessionOrigin` and carries the Site and version headers, which
      the Site frame guard validates again.
    - Its workspace tools are the publication's `agent.tools` for workspace
      members and invited viewers. Everyone else (signed-in `user` viewers
      on a public Site and guests) gets them only when `agent.guestTools` is
      on: tools for everyone who isn't a workspace member or invited (the
      name is kept for compatibility). They are optional references, so an
      unknown connection is skipped.
    - The create body may not choose tools, MCP servers, first-party tools
      or permissions, approval policies, vault policy or connection
      accounts for any other caller acting from a Site page: the session
      routes return 403 `SITE_SESSION_TOOLS_FORBIDDEN`.
    - It is capped with a per-conversation session usage limit, set in the
      create transaction (the host actor `site:<siteId>`), so the first
      turn is capped.
    - The conversation is recorded as owned by this Site and this viewer
      before the session is created, with a session id derived from the
      viewer's idempotency key; a retry returns the same conversation.
  - **Other operations** (list, get, events, stream, send, steer, control,
    queue, queue items, composer draft, human input) work only on the
    viewer's own conversations on this Site. Any other conversation returns
    404 `site_conversation_not_found`.
  - **Site-safe views.** `get`, `list` and `create` return a projection
    without account or workspace ids, instructions, tools or policies,
    metadata, creator, sandbox ids or diagnostics.
  - **Site-safe events.** Event pages and the stream (live SSE and the
    finite `transport=http1-bounded` batch) carry one projection:
    - Delivered event types: messages and their text deltas, tool-call
      receipts, turn and session lifecycle, the queue and usage notices.
    - Payloads keep allowlisted fields: message text, a tool call's id and
      name and whether it failed (never its arguments or output), and short
      status codes (never error text).
    - Every other event (reasoning, sandbox and terminal output, model and
      provider-account telemetry, setup, goals, memory, policies, late or
      duplicate deliveries) arrives as a `session.event.envelope_omitted`
      placeholder with an empty payload, at its own sequence. Sequences stay
      contiguous, so gap detection, backfill and `Last-Event-ID` resume work.
    - The envelope has no workspace id, attempt ids or generations, or
      duplicate, codec or read-bound diagnostics.
  - **Query parameters are allowlisted.**
    - Event pages take `after`, `before`, `direction`, `limit` (default 40,
      at most 500, newest first without a cursor), `compact`, `excludeTypes`,
      `includeTypes` (only visible types; asking for hidden types only
      returns an empty page) and `payloadMode=none`. Read modes, full
      payloads, class filters and `latest` are not offered; responses report
      `monitoring` and `summary`.
    - Streams accept only `after` and `transport`, the queue takes none and
      human input only `status`.
  - **Streams** resume after the gateway-forwarded `Last-Event-ID` when the
    query has no `after`.
  - **Composer drafts** are text only. A draft or submit with resources,
    timeline annotations, credential updates, connection accounts, model
    context or a personal resource attachment returns 400
    `site_invalid_request`. The model must be the publication's, one of the
    profile's `agentModels`, or the conversation's current model; otherwise
    the call returns 400 `site_model_not_allowed`. Submitting a draft is a
    message and counts as a turn.
  - **Queue items** (move, edit, steer, delete) are forwarded with the
    API's own request schemas. Steering a queued message also passes the
    agent and spend checks; the message was already counted when sent.
  - **Budgets.** A start reserves the conversation's whole spend cap
    against the visitor's day, the Site's day and the Site's month, and
    counts the conversation against the visitor's and the Site's starts per
    day, in one transaction that refuses when any is over. A Site-wide
    refusal first sweeps reservations conversations no longer need and
    retries once: a bounded batch of conversations whose session is idle,
    failed or cancelled, starts whose session never appeared, and
    reservations with no work for six hours, least recently visited first
    (each at most every 30 seconds; an empty sweep pauses sweeping that Site
    for a few seconds). Sending, steering and resuming re-check the turn
    count and top the reservation up to the conversation's cap; a
    per-conversation limit lowered since the start lowers the cap and the
    session's own usage limit before the work runs. Settling (on reads,
    later starts and pause or cancel) brings counted spend up to the
    session's actual usage and releases what an idle conversation no longer
    needs. Over budget returns 429
    `site_budget_exhausted` with `{ budget }`: `conversations_per_visitor_per_day`,
    `conversations_per_site_per_day`, `turns_per_conversation`,
    `agent_micros_per_conversation`, `agent_micros_per_visitor_per_day` or
    `agent_micros_per_site_per_month`.
  - **Unavailable agents** return 403 `site_agents_unavailable` with a
    `reason` of `agent_disabled`, `public_agents_disabled`,
    `guest_agents_disabled` or `usage_limits_disabled`.
  - **Human check.** When `OPENGENI_SITES_GUEST_AGENT_HUMAN_CHECK` is on, a
    guest agent start without the human header (`1`) returns 403
    `site_human_check_required`. It is optional (Turnstile is optional), but
    recommended for public Sites that allow guest agents.
  - If the session cannot be created, its reservation is released; if a
    session appears that the conversation record does not track, it is
    cancelled and the call returns 502 `site_conversation_failed`.

## Limits and metering

The effective limits come from the first profile that exists, in this
order: the publication's profile, the workspace default, then the free
defaults from settings.

- `credits` multiplies the conversation and spend limits by
  `OPENGENI_SITES_CREDITS_LIMIT_MULTIPLIER`.
- `unlimited` removes the budgets but keeps `UNLIMITED_SITE_FLOOD_BRAKES`.
- `custom` merges valid overrides over the free defaults.
- The flood brakes apply under every profile.

Counters are single-row upserts in `site_runtime_rate_windows` (per minute)
and `site_runtime_usage` (per day and month). Rate windows can overshoot by
a request or two under concurrency. Agent budgets are conditional
reservations, so concurrent starts and top-ups cannot overshoot them, but
counted spend can still end slightly above a budget in these bounded cases:

- A model call that is already running finishes even when it crosses the
  session's usage limit (see `docs/session-usage-limits.md`), so a
  conversation can end a little above its cap.
- A reservation released after six hours without admitted work or counted
  spend frees the budget even if that session is somehow still running; it
  is still capped by its own usage limit, so the overshoot is at most that
  conversation's remaining cap.
- A reservation counted in a day or month that has since ended is not
  carried into the new period; the conversation's spend is still counted
  when it lands.

Every profile has a per-conversation cap (the flood brake applies to
`unlimited` too), so every conversation reserves.

Old rate windows, usage rows and expired viewer sessions are deleted in
small batches on the write path.

Agent spend is billed to the organization through the normal session usage
ledger. Sign-ins, reports and Site Data use are recorded as usage-only
events.

## Edge sync and staleness

With the Cloudflare settings present, every publish, update, unpublish,
takedown, restore, new version, rollback, archive or audience change does
the following after the database commit:

- It writes the Site's `SiteHostMapRecord` to KV under `host:<hostname>`
  through the REST API, with `expiration_ttl` set to
  `OPENGENI_SITES_HOST_MAP_TTL_SECONDS`.
- It never replaces a record with a higher `generation`. Generations come
  from one database sequence shared by every hostname, so a moved label or
  a tombstone always outranks what was written before. A released label
  gets an `unpublished` tombstone. The gateway keys its caches on host and
  generation.
- On takedown and unpublish, it purges the host from the zone cache.

Failures are retried three times with backoff and logged. They never block
or roll back the database write.

KV has no compare-and-set. The generation check is read-then-write, so two
concurrent writers can briefly leave an older record.

**Staleness bound.** The API refuses a suspended or unpublished Site on the
very next site-runtime call: data, file, tool, agent and version calls are
re-checked every time. The edge copies lag: a KV write takes up to about 60
seconds to reach other Cloudflare locations, the gateway caches host lookups
for up to 60 seconds and access checks for 30 seconds, and a cache purge
(when a zone id is set) clears cached shells. If sync fails, is not
configured or is lost (the after-commit sync runs in process, so a restart
can drop a pending write), the record expires after
`OPENGENI_SITES_HOST_MAP_TTL_SECONDS`, and the next signed host lookup for
the label resyncs a stale record. A missed sync is corrected within the TTL
plus 60 seconds (360 seconds by default). The gateway should write its own
KV fallback entries with a TTL no longer than this setting.

## Abuse and scanning

- Viewers report through `POST /v1/site-runtime/site/reports`. Owners and
  admins triage through the reports routes above.
- Each reporter (signed-in session, guest visitor or client address) and
  each client address may send
  `OPENGENI_SITES_REPORTS_PER_MINUTE_PER_VISITOR` reports a minute (5 by
  default), and a Site accepts 60 a minute from everyone together, so one
  reporter never fills a Site's cap.
- Dismissed and actioned reports are deleted 180 days after they were made
  (a bounded cleanup when the Site receives its next report). Open reports
  stay until someone resolves them; a takedown actions them all.
- Every report and flagged scan reaches the operator: a structured
  `site_abuse_notice` log line, and, when `OPENGENI_SITES_ABUSE_EMAIL` is
  set and managed email is configured, an email (at most one per Site and
  kind per hour, best effort). `bun scripts/operator/site-moderation-queue.ts`
  lists open reports and flagged scans across workspaces. It needs the
  role that owns the Opengeni schema (the migrations credential), which
  reads across workspaces through owner-only read policies, or a superuser
  or `BYPASSRLS` role; the application role is refused.
- After a version is published, the content scanner checks the URLs found
  in its HTML.
  - The default scanner is `none`, which records nothing.
  - Google Web Risk runs only when `OPENGENI_SITES_WEB_RISK_API_KEY` is set.
    It records its findings on the publication and never blocks publishing.
