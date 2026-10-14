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
| `/_og/auth/logout` | GET shows a script-free confirmation; the same-origin POST calls signed `POST /v1/site-runtime/auth/logout` (best effort) and clears the session |
| `/_og/v/<versionId>` | Site HTML with the bridge bootstrap, the Site sandbox CSP and `frame-ancestors 'self'`, only for `Sec-Fetch-Dest: iframe` (anything else is redirected to `/`). `Cache-Control: private, no-cache` with an ETag; the current version is edge-cached for 60 seconds per host, generation, Site and version, after the access check |
| `/_og/api/*` | Same-origin Site calls: re-checked against `matchSiteOperation` and `SITE_TOOL_METHODS`, rate-limited, size-capped, signed and forwarded to `${API_ORIGIN}/v1/site-runtime<suffix>`; SSE streams through |
| `/_og/report` | Script-free abuse report form, posting a `SiteAbuseReportRequest` to signed `POST /v1/site-runtime/site/reports` (same-origin plus a form token); reports go to the Site's owners and the abuse team, and the pages show `ABUSE_EMAIL` |
| `/_og/human` | Turnstile verification (only when both Turnstile values are set) |
| `/_og/internal/site-db` | PR B extension point (per-Site Durable Object storage); 404 until bound, 501 when bound |
| anything else (GET) | The shell page: nonce'd bridge-host script, a full-viewport sandboxed iframe (`allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals`, never `allow-same-origin`) on `/_og/v/<versionId>`, and a Report link |

A trailing-dot host (`<site>.<domain>.`) is redirected to the canonical
host. Unknown, unpublished or version-less hosts get a neutral 404; suspended Sites
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
| `TURNSTILE_SECRET` | Optional Turnstile siteverify secret |

Bindings:

| Binding | Kind | Use |
| --- | --- | --- |
| `HOST_MAP` | KV namespace | Host-map records at `siteHostMapKey(host)`, written by the API's edge sync; the gateway reads with `cacheTtl` 60 and writes back API lookups for 5 minutes after a fresh (uncached) read, only when strictly newer than the stored generation, so a suspension is never overwritten by an older record |
| `RATE_LIMITER` | Rate limiting (`[[ratelimits]]`) | Per-Site flood brake for `/_og/api/*` and reports. Every request is limited on the client IP (`CF-Connecting-IP`) and, when present, also on the verified visitor; both must pass, so rotating `__Host-og_v` doesn't reset a budget. 429 on limit |
| `SITE_DB` | Durable Object namespace (PR B, commented out) | Optional per-Site SQLite storage; see `src/site-db.ts` |

`wrangler.toml` holds the local development configuration at the top level.
`[env.staging]` and `[env.production]` are placeholders: the ops repository
owns real account ids, routes, KV and rate-limit namespace ids, and secrets.
No domain is named in this app.

## Cookies

All are `__Host-` cookies (`Secure; HttpOnly; SameSite=Lax; Path=/`, no
`Domain`):

- `__Host-og_v`: anonymous visitor id, `<128-bit id>.<HMAC>`; only a verified id is forwarded.
- `__Host-og_session`: opaque site-session token from the auth exchange; the API validates it.
- `__Host-og_login`: signed state, PKCE verifier and return path for 10 minutes.
- `__Host-og_h`: signed human proof bound to the Site host and visitor, for 1 hour (Turnstile only).

Inbound cookies and `Authorization` are never forwarded, and API
`Set-Cookie` headers are dropped.

## Caching and takedown latency

The gateway's colo caches (`caches.default`) are keyed by URLs on the real
Site host under `/_og/cache/`, so a Cloudflare purge by hostname drops them.
Entries that depend on the host-map record also carry its `generation`, so a
new record never reads an older entry:

| Cache | Key | Lifetime |
| --- | --- | --- |
| Host map | KV `host:<hostname>` | KV `cacheTtl` 60 seconds per colo; write-back entries expire after 5 minutes |
| No such host | host | 10 seconds |
| Access confirmation (members, invited, login-only) | host, generation, session hash | 30 seconds |
| Current version HTML | host, generation, Site, version | 60 seconds |
| Browser copy of version HTML | `private, no-cache` plus ETag | revalidated on every load |

What a takedown (or unpublish, or an access change) looks like in practice:

- Site API calls through `/_og/api` stop as soon as the API refuses them; the API checks its own database on every call.
- New loads of the Site HTML stop within 60 seconds, or immediately where the API's purge by hostname has run, because an expired or purged entry is fetched from the API again.
- The takedown page replaces the shell once a colo sees the new KV record: KV propagation (usually within a minute) plus up to 60 seconds of `cacheTtl`, so up to about 2 minutes in the worst case.
- A tab that already has the Site open keeps its loaded document until it reloads, but its API calls fail.

A first publish appears within about 10 seconds at a colo that recently looked
the name up and found nothing.

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
on an ephemeral loopback port (set `SITE_GATEWAY_TEST_API_PORT` to pin one)
that verifies every gateway signature independently.

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
