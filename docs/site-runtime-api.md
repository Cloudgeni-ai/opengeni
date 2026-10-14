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
| `OPENGENI_SITES_ABUSE_EMAIL` | unset | Abuse contact shown in `SiteRuntimeConfig` and takedown pages |
| `OPENGENI_SITES_GUEST_AGENT_HUMAN_CHECK` | `false` | A guest agent start needs the gateway's human header |
| `OPENGENI_SITES_FREE_REQUESTS_PER_MINUTE_PER_VISITOR` | 120 | Free limit |
| `OPENGENI_SITES_FREE_GUEST_WRITES_PER_MINUTE` | 30 | Free limit |
| `OPENGENI_SITES_FREE_CONVERSATIONS_PER_VISITOR_PER_DAY` | 10 | Free limit |
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
| `PUT` (`UpsertSitePublicationRequest`) | 201 when it first publishes, otherwise 200 | 403 `site_manager_required`, `site_admin_required` (limit profile), `site_public_disabled`; 409 `site_not_shared`, `site_archived`, `site_suspended`, `site_taken`, `site_held`; 400 `site_model_not_allowed`, `site_invalid_request` |
| `DELETE` (unpublish) | 200 | 409 `site_suspended` |
| `POST /takedown` (`SiteTakedownRequest`) | 200 | 403 `site_owner_or_admin_required` |
| `POST /restore` | 200 | 403 when the platform took the Site down |
| `GET /reports?status=` | 200 list | |
| `PATCH /reports/:reportId` | 200 | 404 `site_report_not_found` |

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

Takedown:

- A takedown sets the status to `suspended` at once, actions the open
  reports, records an audit event, writes the edge host map and purges the
  edge cache.
- The owner or a workspace admin can restore their own takedown.
- Only the operator script can lift a platform takedown:
  `bun scripts/operator/site-takedown.ts --host <label> --operator <name> --reason "..."`
  takes a Site down, and adding `--restore` lifts it. Opengeni has no
  platform-admin API.

Agent tools: `site_publication_get`, `site_publication_update` and
`site_hostname_check` call the same service with the person's authority.

## Viewer sign-in

1. The gateway sends a signed-out viewer of a `members` or `invited` Site,
   or of a `public` Site on a login-only deployment, to the console's
   authorize page with a PKCE challenge.
2. The page calls `POST /v1/site-auth/authorize` (`SiteAuthAuthorizeRequest`)
   with the person's normal app session. It returns
   `200 { redirectTo, site }`.
   - The API checks access: `members` needs a workspace member; `invited`
     needs a member or a verified email on the invite list; `public` accepts
     any user.
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

A failure returns `401 site_gateway_signature_invalid`, with
`details.reason` set to `missing_headers`, `bad_timestamp`, `skew`,
`bad_signature` or `credentials`.

The gateway must sign the normalized path. A path with dot segments is
normalized by the URL parser before verification, so it fails the
signature.

### Host and viewer

- **Host.** The signed host must name an active publication. A missing host
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
  Going over returns 429 `site_rate_limited` with `{ bucket,
  retryAfterSeconds }`.

### Routes

| Method and suffix | Result |
| --- | --- |
| `GET /host` | `SiteHostMapRecord` for the signed host (the gateway's fallback on a KV miss), or 404 `site_not_found`. An optional `host` query must equal the signed host |
| `GET /versions/:versionId/html` | The immutable HTML of a version of this Site, with a sandbox CSP, `private, max-age=31536000, immutable` and an ETag. 404 `site_version_not_found` for another Site's version |
| `POST /auth/exchange` | `SiteAuthExchangeResponse`. 400 `site_auth_code_invalid` (wrong verifier, host or redirect URI, expired, or already used) |
| `POST /auth/logout` | 200 `{ revoked }`, even when the Site no longer exists |
| `POST /site/reports` | 201. Rate limited per visitor |
| `POST /tools/:method` | 403 `site_tools_unavailable` (direct tools need a person's session in the console) |
| `SITE_OPERATIONS` suffixes | Served for the viewer, as below. Anything else returns 404 `site_operation_unsupported` |

A Site may roll back to any of its versions, so the version route serves
every version of the same Site. Version ids are random UUIDs. To make old
content unreachable, unpublish the Site or take it down.

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
    - It is capped with a per-conversation session usage limit.
    - The conversation is recorded as owned by this Site and this viewer.
  - **Other operations** (list, get, events, stream, send, steer, control,
    queue, queue items, composer draft, human input) work only on the
    viewer's own conversations on this Site. Any other conversation returns
    404 `site_conversation_not_found`.
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
  - **Budgets.** Create and send check the turns per conversation, the
    conversations per visitor per day, the spend per visitor per day and
    the spend per Site per month. Over budget returns 429
    `site_budget_exhausted` with `{ budget }`.
  - **Unavailable agents** return 403 `site_agents_unavailable` with a
    `reason` of `agent_disabled`, `public_agents_disabled`,
    `guest_agents_disabled` or `usage_limits_disabled`.
  - **Human check.** When `OPENGENI_SITES_GUEST_AGENT_HUMAN_CHECK` is on, a
    guest agent start without the human header (`1`) returns 403
    `site_human_check_required`.
  - If the usage cap cannot be applied, the new session is cancelled and
    the call returns 503 `site_conversation_failed`.

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
and `site_runtime_usage` (per day and month). Concurrent requests can
overshoot a budget by a request or two.

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
- It never replaces a record with a higher `generation`. A released label
  gets an `unpublished` tombstone.
- On takedown, it purges the host from the zone cache.

Failures are retried three times with backoff and logged. They never block
or roll back the database write.

KV has no compare-and-set. The generation check is read-then-write, so two
concurrent writers can briefly leave an older record.

**Staleness bound.** If sync fails or is not configured, a stale host record
lives at most `OPENGENI_SITES_HOST_MAP_TTL_SECONDS` plus the gateway's 60
second edge cache, which is 360 seconds by default. The gateway should write
its own KV fallback entries with a TTL no longer than this setting. Data,
file, tool and agent calls are not affected by this window, because the API
re-checks the publication and the viewer's access on every runtime call. A
takedown therefore stops them at once. The window applies only to the
gateway shell and cached version HTML, and the takedown cache purge shortens
it when a zone id is set.

## Abuse and scanning

- Viewers report through `POST /v1/site-runtime/site/reports`. Owners and
  admins triage through the reports routes above.
- After a version is published, the content scanner checks the URLs found
  in its HTML.
  - The default scanner is `none`, which records nothing.
  - Google Web Risk runs only when `OPENGENI_SITES_WEB_RISK_API_KEY` is set.
    It records its findings on the publication and never blocks publishing.
