# Published Sites gateway

A Cloudflare Worker that serves published Opengeni Sites on their own
hostnames (`<label>.<sites domain>`). It is deliberately thin: host lookup,
cookies, sign-in redirects, request signing, caching of immutable Site HTML,
and security headers. Every authorization decision stays in the Opengeni API
(`/v1/site-runtime/*`). Design record:
[docs/design/published-sites-2026-10-14.md](../../docs/design/published-sites-2026-10-14.md);
shared contracts: `packages/contracts/src/site-publishing.ts`.

## Routes on every Site host

| Path | Behavior |
| --- | --- |
| `/robots.txt` | Disallow-all when the Site or deployment is noindex; otherwise disallows `/_og/` only |
| `/_og/auth/login` | Mints state and a PKCE S256 verifier in `__Host-og_login` (10 minutes) and redirects to `${APP_ORIGIN}/site-auth/authorize` |
| `/_og/auth/callback` | Verifies state, exchanges the code with signed `POST /v1/site-runtime/auth/exchange`, sets `__Host-og_session`, returns to a same-host relative path |
| `/_og/auth/logout` | Signed `POST /v1/site-runtime/auth/logout` (best effort) and clears the session |
| `/_og/v/<versionId>` | Immutable Site HTML with the bridge bootstrap, the Site sandbox CSP and `frame-ancestors 'self'`; edge-cached per Site and version after the access check |
| `/_og/api/*` | Same-origin Site calls: re-checked against `matchSiteOperation` and `SITE_TOOL_METHODS`, rate-limited, size-capped, signed and forwarded to `${API_ORIGIN}/v1/site-runtime<suffix>`; SSE streams through |
| `/_og/report` | Script-free abuse report form, posting a `SiteAbuseReportRequest` to signed `POST /v1/site-runtime/site/reports` (same-origin plus a form token) |
| `/_og/human` | Turnstile verification (only when both Turnstile values are set) |
| `/_og/internal/site-db/<siteId>/<operation>` | Site SQL (optional per-Site storage): signed `POST` from the API only (see below), forwarded to the Site's `SiteDatabase` Durable Object; 404 without the `SITE_DB` binding |
| anything else (GET) | The shell page: nonce'd bridge-host script, a full-viewport sandboxed iframe (`allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals`, never `allow-same-origin`) on `/_og/v/<versionId>`, and a Report link |

Unknown, unpublished or version-less hosts get a neutral 404; suspended Sites
get a 410 takedown page with the abuse contact. Members and invited Sites (and
every Site when `LOGIN_ONLY` is set) need a site session the API confirms
through `GET /v1/site-runtime/site/config`; without one the visitor goes to
sign-in.

The shell's browser script is the shared Site bridge host
(`@opengeni/sdk/site-bridge-host`, also used by the console frame) plus a
gateway transport. It is bundled into `src/shell/shell-script.gen.ts`:

```sh
bun run build:shell   # regenerate after changing src/shell or the SDK bridge host
bun run check:shell   # fail when the committed bundle is stale (also a unit test)
```

## Configuration

Vars (`[vars]` in `wrangler.toml`):

| Name | Meaning |
| --- | --- |
| `SITES_DOMAIN` | Parent domain of Site hostnames; the gateway answers 404 for anything else |
| `API_ORIGIN` | Opengeni API origin (https; plain http only on loopback) |
| `APP_ORIGIN` | Opengeni console origin that hosts `/site-auth/authorize` |
| `ENVIRONMENT` | `development` or `test` allow plain-HTTP Site origins and omit HSTS; anything else redirects to https |
| `FORCE_NOINDEX` | `true` adds `X-Robots-Tag: noindex` and a disallow-all robots.txt for every Site |
| `LOGIN_ONLY` | `true` makes public Sites require sign-in (staging) |
| `ABUSE_EMAIL` | Contact on the takedown page; defaults to `abuse@<SITES_DOMAIN>` |
| `TURNSTILE_SITE_KEY` | Optional; enables the human check together with `TURNSTILE_SECRET` |

Secrets (`.dev.vars` locally, `wrangler secret put` when deployed):

| Name | Meaning |
| --- | --- |
| `GATEWAY_SECRET` | At least 32 characters, shared with the API; signs API requests (`siteGatewayCanonicalString`, HMAC-SHA256, `v1=<base64url>`) and gateway cookies |
| `GATEWAY_SECRET_PREVIOUS` | Optional; the previous `GATEWAY_SECRET` during a rotation. Only the internal Site SQL route accepts it |
| `TURNSTILE_SECRET` | Optional Turnstile siteverify secret |

Bindings:

| Binding | Kind | Use |
| --- | --- | --- |
| `HOST_MAP` | KV namespace | Host-map records at `siteHostMapKey(host)`, written by the API's edge sync; the gateway reads with `cacheTtl` 60 and writes back API lookups for 5 minutes, never over a newer generation |
| `RATE_LIMITER` | Rate limiting (`[[ratelimits]]`) | Per-Site flood brake for `/_og/api/*` and reports, keyed by verified visitor or client IP; 429 on limit |
| `SITE_DB` | Durable Object namespace, class `SiteDatabase` (`[[migrations]] tag = "v1"`, `new_sqlite_classes`) | Optional per-Site SQLite storage (Site SQL); bound for local development, commented out in the staging and production placeholders |

`wrangler.toml` holds the local development configuration at the top level.
`[env.staging]` and `[env.production]` are placeholders: the ops repository
owns real account ids, routes, KV and rate-limit namespace ids, and secrets.
No domain is named in this app.

## Site SQL storage

`src/site-database.ts` exports `SiteDatabase` (also exported from the Worker
entry): one SQLite-backed Durable Object per Site, `SITE_DB.idFromName(siteId)`.
Postgres keeps the definitions (migrations and named queries); the object
holds the rows. `src/site-db.ts` serves the internal route the API calls:

- `POST /_og/internal/site-db/<siteId>/<operation>`, operation one of
  `run`, `script`, `migrate`, `insert`, `export`, `inspect`, `reset`.
- Signed like gateway-to-API requests: `siteGatewayCanonicalString` over the
  method, the request's host and path, the body's SHA-256 and the timestamp,
  with empty session, visitor, client IP and human fields (a request that
  carries any viewer header is refused). The current or previous secret is
  accepted within 30 seconds; the Durable Object refuses a repeated request
  id.
- `no-store`, no cookies; another method, a bad path, a query string, a body
  over 8 MB or a bad signature is refused before the Durable Object is
  touched. Outside development the route needs https.
- `migrate` takes an optional `position` per migration (its Postgres
  ordinal), so the API can send only the missing ones in bounded calls;
  `inspect` takes `migrationsOnly`; every `export` page carries the schema,
  so the API can end a dump (triggers last) on whichever page finishes it.

The API has already authorized the caller, applied limits and resolved
named queries; the Durable Object still re-checks every statement with
`compileSiteSql`, binds values only as parameters, runs each call in one
transaction, bounds rows and response size and enforces the storage cap.
Its bookkeeping (request ids seen, migrations applied with the checksum it
recomputes) is in the Durable Object's key-value storage (`ctx.storage.kv`),
which workerd keeps in `_cf_KV` and refuses to user SQL, so no statement or
trigger can touch it; there are no bookkeeping tables in the database.
The route checks the timestamp, skew and signature header before reading
the body.
Site pages never reach the route: `site.sql.run` goes through `/_og/api` to
the API, which calls back here. The route works on any host the Worker
serves; deployments should point the API's
`OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN` at a reserved label such as
`internal.<sites domain>` that no Site can take. See
[docs/site-data.md](../../docs/site-data.md#site-sql-optional-cloudflare-storage).

## Cookies

All are `__Host-` cookies (`Secure; HttpOnly; SameSite=Lax; Path=/`, no
`Domain`):

- `__Host-og_v`: anonymous visitor id, `<128-bit id>.<HMAC>`; only a verified id is forwarded.
- `__Host-og_session`: opaque site-session token from the auth exchange; the API validates it.
- `__Host-og_login`: signed state, PKCE verifier and return path for 10 minutes.
- `__Host-og_h`: signed, visitor-bound human proof for 1 hour (Turnstile only).

Inbound cookies and `Authorization` are never forwarded, and API
`Set-Cookie` headers are dropped.

## Local development

No Cloudflare account is needed. Run the API on `127.0.0.1:8000` and the
console on `127.0.0.1:3000`, then:

```sh
cd apps/site-gateway
printf 'GATEWAY_SECRET=%s\n' "$(openssl rand -hex 32)" > .dev.vars  # same value as the API
bunx wrangler@4 dev --port 8787
```

Browsers resolve `*.localhost` to loopback, so a Site published as `demo` opens
at `http://demo.sites.localhost:8787`. Never run `wrangler deploy` or
`wrangler login` from this repository.

## Tests

```sh
cd apps/site-gateway
bun test                     # unit tests and the Miniflare (workerd) integration test
bun run typecheck
```

`test/worker.miniflare.test.ts` builds the Worker, runs it in workerd through
Miniflare with KV and a rate limiter, and points it at a fake site-runtime API
on `127.0.0.1:18790` that verifies every gateway signature independently.
`test/site-db.miniflare.test.ts` runs the `SiteDatabase` Durable Object in
workerd: signatures, secret rotation, skew and replay, statement refusals,
limits, migrations, rebuild, export and import. `test/site-database.test.ts`
covers request-id expiry and pruning with a fake clock.

## What the API serves for the gateway

All requests are signed (timestamp within `SITE_GATEWAY_MAX_SKEW_SECONDS`) and
carry the host, session, visitor, client IP and human headers:

| Route | Responses the gateway relies on |
| --- | --- |
| `GET /v1/site-runtime/host` | 200 `SiteHostMapRecord`; 404 unknown host |
| `GET /v1/site-runtime/site/config` | 200 `SiteRuntimeConfig`; 401 no or invalid session; 403 no access; 404/410 gone |
| `GET /v1/site-runtime/versions/<id>/html` | 200 raw Site HTML (the gateway injects the bridge bootstrap); 401/403; 404/410 |
| `POST /v1/site-runtime/auth/exchange` | 200 `SiteAuthExchangeResponse`; 400/401 invalid code; 403 no access |
| `POST /v1/site-runtime/auth/logout` | 2xx |
| `POST /v1/site-runtime/site/reports` | 2xx; 429 |
| `POST /v1/site-runtime/tools/<method>` | The tool method result as JSON, errors in the API error envelope |
| Every `SITE_OPERATIONS` entry at `/v1/site-runtime<suffix>` | As the workspace route; 403 with code `site_human_check_required` asks for Turnstile |

The API never sets cookies on a Site origin.
