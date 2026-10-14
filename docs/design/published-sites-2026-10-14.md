<!-- docs-refs: record -->

> **Point-in-time design record.** Written against `main` at `64bbe226` on
> October 14, 2026. Code wins where the implementation later differs. This
> record supersedes the "no separate Site host or wildcard Site domain"
> decision in [workspace-html-sites-2026-09-01.md](workspace-html-sites-2026-09-01.md);
> everything else in that record (single-file Sites, the opaque-origin frame,
> the MessagePort bridge, provenance) still stands. Tracking: Linear OPE-802,
> which also closes OPE-801.

# Published Sites and optional Cloudflare storage

## Purpose

A workspace Site today is visible only inside the Opengeni console, to
members of its workspace, in a sandboxed opaque-origin iframe. This design
lets the owner publish the same Site on its own hostname under a Sites
domain (`<name>.opengeni.site` in production, a separate staging domain on
staging), to workspace members, to invited people, or to the public, with
the Site's embedded agents, Site Data and tools working the same way, under
strict limits paid by the organization.

It also closes OPE-801: Site HTML could reach the viewer's general
workspace API through the console bridge, because `siteSessionPath` was a
URL-prefix boundary rather than an operation allowlist.

## Decisions

1. **Configurable domains.** `OPENGENI_SITES_DOMAIN` names the Sites domain;
   nothing in code names a concrete domain. Production uses `opengeni.site`;
   staging uses its own registrable domain (never a subdomain of production).
   Publishing is off when the setting is unset.
2. **Flat one-level hostnames.** `<label>.<sites domain>`; labels are one DNS
   label of 3-63 characters (`a-z`, `0-9`, `-`; no leading or trailing
   hyphen; no `--` in positions 3-4, so no punycode). They are globally unique
   across all workspaces and checked against a reserved list and a blocked
   brand/credential word list (`packages/contracts/src/site-publishing.ts`).
   Default labels are a slug plus a random suffix (`team-dashboard-4k9x`). A
   released label stays held for its workspace for 30 days.
3. **Three access modes.** `members`, `invited` (members plus invited email
   addresses who sign in to Opengeni) and `public`. Public publishing and
   embedded agents on public Sites are on by default and controlled by limit
   profiles and deployment settings. A Site must be visible to its workspace
   (not "Only me") to be published.
4. **Guest principal.** Anonymous visitors of public Sites are
   `guest:<visitorId>`, where the visitor id comes from a gateway-minted,
   gateway-signed `__Host-og_v` HttpOnly cookie. Guests are not workspace
   members, external actors or users; they exist only inside site-runtime.
5. **One gateway Worker.** `apps/site-gateway` is a single Cloudflare Worker
   on `*.<sites domain>`. It serves an Opengeni shell page that embeds the
   unchanged Site HTML in a sandboxed opaque-origin iframe and runs the
   existing MessagePort bridge host. The Worker is thin: host lookup, cookies,
   sign-in redirects, signing and forwarding, caching immutable HTML, and
   security headers. All authorization stays in the Opengeni API.
6. **Narrow site-runtime API.** Site calls go same-origin to `/_og/api/*` on
   the Site host; the gateway signs and forwards them to `/v1/site-runtime/*`
   on the configurable API origin. Site-runtime serves only the Site
   operation allowlist (`SITE_OPERATIONS`), the tool bridge methods, viewer
   sign-in exchange, host lookup and version HTML. It never accepts Opengeni
   app credentials, and no Opengeni credential ever reaches a Site origin.
7. **Sign-in by redirect.** The gateway redirects to the app's
   `/site-auth/authorize` with state and a PKCE challenge kept in a
   `__Host-og_login` cookie. The signed-in app mints a one-time code bound to
   host, challenge and redirect. The gateway exchanges it server-to-server for
   an opaque site-session token (the API stores only its hash; 12 h idle,
   7 days absolute) and sets the host-only `__Host-og_session` cookie. A
   site-session token is valid only on site-runtime for that one Site.
8. **Strict edge headers.** The shell sends a strict CSP (nonce scripts, no
   inline handlers, `frame-src 'self'`, `connect-src 'self'`), `frame-ancestors
   'none'`, COOP `same-origin`, CORP `same-origin`, `nosniff`,
   `Referrer-Policy: no-referrer` and a Permissions-Policy denying powerful
   features. The Site HTML response carries the existing Site sandbox CSP as a
   header and is framable only by its own shell (`frame-ancestors 'self'`).
   `X-Robots-Tag: noindex` is the default; staging forces noindex and
   login-only.
9. **Storage.** Postgres and the configured object storage (azure-blob,
   aws-s3, gcs, s3-compatible) remain the source of truth. Cloudflare holds
   only rebuildable copies: the KV host map and the edge cache of immutable
   versioned HTML. No R2 at launch. The optional per-Site Durable Object
   database (PR B) is the one Cloudflare-resident store, and it always has
   export and import.
10. **Limits and billing.** Cloudflare cannot cap spend, so the edge only
    brakes (rate-limit binding, WAF rule, Worker CPU limit) and Opengeni
    enforces limit profiles stored in Postgres: `free` (strict defaults),
    `credits`, `unlimited` (still keeps flood brakes and per-conversation
    caps) and `custom`, per workspace and per Site. Embedded agent spend is
    paid by the organization and metered into the credit ledger in
    `usage_only` mode, extending Site Data's metering.
11. **Abuse basics.** Every published Site shows a small "Report" link from
    the shell. Owners and workspace admins can take a Site down at once
    (host map set to `suspended`, edge cache purged, audit event); platform
    admins can too. Reports go to Postgres and the abuse contact
    `abuse@<sites domain>` (forwarded to support by Cloudflare Email Routing,
    configured with the account). Reports and flagged scans also reach the
    operator: a structured `site_abuse_notice` log line, an email to
    `OPENGENI_SITES_ABUSE_EMAIL` through managed email when configured, and
    a cross-workspace queue script (`scripts/operator/site-moderation-queue.ts`).
    A pluggable content scanner interface has a Google Web Risk
    implementation that is disabled without a key.
12. **Cloud-agnostic API.** Nothing in the API depends on Azure or on
    Cloudflare being present. Edge sync (KV writes, cache purge) is optional
    and a no-op when its settings are unset; the gateway falls back to the
    API for host lookups. The gateway reaches the API by a configurable origin.
13. **D1 is not used.** Per-Site isolation, single-writer semantics,
    co-location with the gateway, and no shared-database blast radius make
    one SQLite Durable Object per Site the better fit; D1 offers no feature
    we need that a SQLite-backed DO lacks, and adds a per-account database
    limit and a shared control plane. Recorded here so the choice is explicit.

## Request flows

### Page load

1. `GET https://team-4k9x.<domain>/anything` reaches the gateway. The gateway
   parses the label (`parseSiteHostname`); anything else is a 404.
2. It reads `host:<hostname>` from KV (60 s edge cache); on a miss it calls
   signed `GET /v1/site-runtime/host` and writes the result back to KV with a
   short TTL. Missing, unpublished or suspended hosts get a neutral page
   (`suspended` shows the takedown notice and the abuse contact).
3. Access: `public` serves anonymous visitors (minting `__Host-og_v` if
   absent) unless the deployment is login-only; `members` and `invited`
   require `__Host-og_session`, otherwise the gateway redirects to
   `/_og/auth/login`. The API re-checks access on every runtime call.
4. The gateway returns the shell: a small HTML page with a nonce'd script, a
   full-viewport `<iframe sandbox="allow-scripts allow-forms allow-popups
   allow-popups-to-escape-sandbox allow-downloads allow-modals"
   src="/_og/v/<versionId>">` (never `allow-same-origin`), and a footer
   strip with the Report link. The shell runs the framework-free bridge host
   (`packages/sdk/src/site-bridge-host.ts`, shared with the console's
   `PublishedHtmlArtifactFrame`).
5. `GET /_og/v/<versionId>` is served from the edge cache after the same
   host and access check; on a miss the gateway fetches signed
   `GET /v1/site-runtime/versions/<versionId>/html` (only the host's current
   version, or one a publish or rollback replaced within the last ten
   minutes so already open pages keep loading) and caches it per host and
   generation.

### Site calls

The in-Site SDK is unchanged: `createOpenGeniSiteClient` connects over the
MessagePort. The shell's bridge host matches each HTTP request with
`matchSiteOperation` and forwards allowed operations to
`/_og/api<suffix>`; tool bridge methods go to `/_og/api/tools/<method>`;
`viewer` and `auth.signIn` are answered by the shell. The gateway signs
every `/_og/api` request (`siteGatewayCanonicalString`, HMAC-SHA256,
`v1=<base64url>`, 30 s skew, body hash) with the host, raw site-session
token (if any), visitor id, client IP and human-check flag, and forwards to
`/v1/site-runtime<suffix>`, with the signed body hash also in the required
`x-opengeni-site-body-sha256` header so the API verifies the signature
before reading the body, then checks the body against it. The API verifies
the signature (current or previous secret), resolves the host to the publication, resolves the viewer,
enforces access and limits, and serves the operation.

### Agents

Site-runtime agent sessions run as a service principal
`site:<siteId>` with narrow permissions, created through in-process
dispatch with a short-lived delegated token, `agentAccess: "session"`, the
publication's model, instructions and tool list, an end-user label for the
viewer, the Site (and version) as provenance, and a per-conversation
session usage limit from the effective limits. Ownership of each
conversation (Site, viewer principal) is recorded in site-runtime's own
table; a viewer can only list, read, stream and message their own
conversations on that Site. Conversation, visitor-day and Site-month
budgets are checked before each new conversation and message.

## OPE-801: operation allowlist and provenance

- `SITE_OPERATIONS` in `packages/contracts/src/site-operations.ts` (zod-free,
  re-exported from the contracts index) is the single allowlist. The console bridge (`siteSessionPath`,
  `createSiteToolBridge`), Codemode's Site proxy and the gateway shell all
  use it; anything else is refused before any request is made.
- Every route that starts or messages an agent (session create, send,
  steer, control, scheduled task create/update/trigger, automations)
  records the originating Site and version when the request came from a Site
  frame. Session create honours the frame marker (`x-opengeni-site-frame`), so
  inline HTML is attributed too. Site-surface turns record which Site.
- A Site may message only sessions that it originated; a page on Site B
  cannot send to a session started from Site A.
- A Site-clamped agent cannot create or change schedules, automations or
  Site publications, and reads, messages, steers or controls only sessions
  acting for its own Site. Site pages cannot change publications either,
  nor choose tools or authority in a session create body.
- `docs/agent-session-authority.md` and `AGENTS.md` describe the allowlist
  correctly.

## Data model (PR A)

New workspace-owned FORCE-RLS tables following `0776_site_data.sql`, plus a
global hostname index:

- `site_publications`: one per Site; label, access, status, noindex, agent
  settings, limit profile, invited emails, suspension fields, generation.
  Generations come from one global sequence, so they rise across hostnames
  (a moved label or a tombstone always outranks older edge records).
- `site_hostnames`: label to Site, globally unique, with `released_at` for
  the 30-day hold. Gateway host lookups use the api_keys-style
  transaction-local GUC "lane" policy (one named label visible at a time)
  instead of disabling RLS; there is no `SECURITY DEFINER` resolver.
- `site_hostname_holds`: labels of platform takedowns, held for the
  platform with no foreign keys, so deleting a Site or workspace does not
  free them.
- `site_auth_codes` (hash, host, challenge, redirect, subject, 60 s TTL,
  single use) and `site_viewer_sessions` (token hash, Site, subject, idle and
  absolute expiry, revocation).
- `site_limit_profiles`: workspace-level default profile (Site-level lives on
  the publication).
- `site_runtime_conversations`: session id, Site, viewer principal, created
  at, the conversation's cap and its reserved spend; used for ownership and
  for reserving each conversation's cap against the visitor-day, Site-day
  and Site-month budgets in one transaction.
- `site_runtime_usage` / rate windows: per Site per visitor per window
  counters and per day/month spend, maintained without expensive queries.
- `site_abuse_reports` and takedown audit events (existing `audit_events`).

Site Data gains a guest rule per collection (`none` by default, `read`,
`append`, `own`) so public guests reach only what the owner allows.

## Settings

API (`packages/config`, `OPENGENI_SITES_*`): `SITES_DOMAIN`,
`SITES_GATEWAY_SECRET` and `SITES_GATEWAY_SECRET_PREVIOUS`,
`SITES_PUBLIC_ENABLED` (default true), `SITES_PUBLIC_AGENTS_ENABLED`
(default true), `SITES_LOGIN_ONLY` (default false; true on staging),
`SITES_FORCE_NOINDEX` (default false; true on staging),
`SITES_ABUSE_EMAIL` (default `abuse@<domain>`), the free-profile defaults,
viewer session idle and absolute lifetimes, the hostname hold, and optional
edge sync: `SITES_CLOUDFLARE_API_TOKEN`, `SITES_CLOUDFLARE_ACCOUNT_ID`,
`SITES_CLOUDFLARE_KV_NAMESPACE_ID`, `SITES_CLOUDFLARE_ZONE_ID`, plus
`SITES_WEB_RISK_API_KEY`. The app origin comes from the existing
`OPENGENI_WEB_BASE_URL`/`OPENGENI_PUBLIC_BASE_URL`.

Gateway (Wrangler vars and secrets): `SITES_DOMAIN`, `API_ORIGIN`,
`APP_ORIGIN`, `GATEWAY_SECRET`, `ENVIRONMENT`, `FORCE_NOINDEX`,
`LOGIN_ONLY`, `ABUSE_EMAIL`, optional `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET`; bindings `HOST_MAP` (KV) and `RATE_LIMITER`
(rate-limit binding), and in PR B `SITE_DB` (Durable Object namespace).

## PR B: optional Cloudflare storage

One SQLite-backed Durable Object per Site (`idFromName(siteId)`), offered
next to Site Data. Sites call named, parameterized queries through
`site.sql.run(name, params)`; `:viewer` is bound from the verified principal
by the API, never by the Site. Owners define schema migrations and named
queries with agent tools (inspect, query, execute, migrate, define query,
export and import as SQL, CSV or JSON, reset). Statements are checked
against an allowlist: no `ATTACH`, no `PRAGMA` writes, no
`load_extension`, no multiple statements in a named query. The gateway
reaches the Durable Object through its own binding; agents reach it through
HMAC-signed requests from the API to the gateway's internal endpoint. Usage
(rows read and written, storage) is metered like Site Data.

## Alternatives rejected

- **Serving Site HTML directly on the Site origin** (no shell): Site code
  would share an origin with the session cookie and the API proxy.
- **Per-Site Workers or Workers for Platforms**: more moving parts and cost
  for no isolation gain over the opaque-origin frame.
- **R2 copies of Site HTML**: Postgres plus object storage stay the source
  of truth and immutable versions cache well at the edge.
- **Guests as external actors**: that path creates workspace members.
- **D1**: see decision 13.

## Staging rollout

Staging uses its own Sites domain, `LOGIN_ONLY=true` and
`FORCE_NOINDEX=true`. The ops repository deploys the gateway Worker's
staging environment from GitHub Actions once the Cloudflare account,
zone, KV namespace and secrets exist; production deployment is a separate,
later decision.
