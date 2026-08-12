# Fiken connector (first-party)

OpenGeni's first-party connector for [Fiken](https://fiken.no), the Norwegian
small-business accounting service. A workspace connects Fiken either through
the **registered-app OAuth flow** (the default in the UI) or by pasting a
**personal API token**; both produce the same workspace-shared connection, and
the agent reaches Fiken through host-side `fiken_*` tools on the first-party
MCP surface. No Fiken data or credential ever enters the sandbox.

Both lanes sit behind the deployment integrations kill switch: with
`OPENGENI_INTEGRATIONS_ENABLED=false` (the default) the install, OAuth start,
and callback routes all 404.

## The two connect lanes

Both lanes verify against Fiken before anything enters encrypted storage, and
both store one workspace-owned row in the generic `connections` table
(`providerDomain: "fiken.no"`, metadata `credentialRole: "fiken_api_token"`
plus the bounded verified company list and `defaultCompanySlug`). Personal
("Connect only for me") ownership is deliberately **not** supported yet — the
first-party fiken tools resolve only workspace rows until the
delegation-snapshot lane exists for them.

- **OAuth (registered Fiken app).** `POST /v1/workspaces/:id/connections/fiken/oauth/start`
  (SDK `startFikenOAuth`) returns the `https://fiken.no/oauth/authorize` URL
  with signed single-use state; the public callback
  `GET /v1/integrations/fiken/callback` re-checks the subject's
  `connections:write` grant, consumes the state nonce, exchanges the code at
  Fiken's Basic-authenticated token endpoint, discovers the grant's companies,
  and stores a `kind: "oauth2"` connection whose bundle carries
  `token_endpoint` + client credentials in `client_secret_basic` shape — so the
  generic connection broker owns every later refresh, including Fiken's
  rotating refresh tokens (~24 h access-token lifetime). Passing
  `connectionId` re-authorizes an existing Fiken row in place (this also
  upgrades a pasted-token row to OAuth, preserving its default company).
  Requires `OPENGENI_FIKEN_OAUTH_CLIENT_ID` / `OPENGENI_FIKEN_OAUTH_CLIENT_SECRET`
  (register the app in Fiken under *Rediger konto → API* with redirect URL
  `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/fiken/callback`) plus
  `OPENGENI_INTEGRATIONS_STATE_SECRET`; unconfigured deployments 503 the start
  route and the UI still offers the token lane.
- **Personal API token.** `POST /v1/workspaces/:id/connections/fiken/install`
  (SDK `installFikenConnection`) takes `{ apiToken, defaultCompanySlug?, connectionId? }`,
  verifies the token by listing its accessible companies, and stores a
  `kind: "api_key"` row with credential bundle
  `{ headers: { authorization: "Bearer …" } }`. Tokens are created in Fiken
  under *Rediger konto → API* and never expire, so there is no refresh
  machinery — a Fiken 401 marks the connection `needs_reauth` and the fix is a
  fresh credential. A bad paste fails the install route with a specific 422
  instead of failing at first tool use.

## Runtime behavior shared by both lanes

- **Company scoping.** Fiken URLs are per-company (`/companies/{slug}/…`). Every
  tool takes an optional `companySlug`; the connection's `defaultCompanySlug`
  (auto-set when the credential sees exactly one company) fills it in, and
  ambiguity is an error that lists the available slugs.
- **Catalog tile.** `api:fiken` (`surfaceType: "first_party_fiken"`) in the
  capabilities catalog; enablement is derived from the workspace connection row.
  The web connect sheet (`capabilityConnectPlan` mode `fiken_api_token`) leads
  with "Connect with Fiken" (OAuth) and folds the paste-a-token form behind an
  explicit toggle; the callback returns to the Capabilities page with a `fiken`
  query outcome.

## Tools

Registered on the first-party `opengeni` MCP surface
(`apps/api/src/mcp/server.ts`, `registerFikenTools`). Like the other connector
surfaces (`social_*`, `slack_bot_*`), `fiken_*` tools are **explicit-only**:
they are excluded from `DEFAULT_FIRST_PARTY_MCP_TOOLS` and must be selected by
the session's tool policy, and they are independently permission-gated.

| Tool | Permission | Notes |
| --- | --- | --- |
| `fiken_companies_list` | `connections:read` | Slugs for `companySlug` |
| `fiken_contacts_list` | `connections:read` | Name/email/org-number/customer/supplier filters |
| `fiken_products_list` | `connections:read` | |
| `fiken_invoices_list` | `connections:read` | Date/customer/settled filters; amounts in øre |
| `fiken_invoice_get` | `connections:read` | |
| `fiken_bank_accounts_list` | `connections:read` | Reconciled balances in øre |
| `fiken_purchases_list` | `connections:read` | |
| `fiken_sales_list` | `connections:read` | |
| `fiken_contact_create` | `connections:write` | No provider idempotency; the tool description warns about retry duplicates |
| `fiken_invoice_draft_create` | `connections:write` | **Draft only** — never sends an invoice. Caller-supplied `operationId` UUID doubles as the Fiken draft `uuid`, so a retry finds and returns the existing draft instead of duplicating it |

There is deliberately no invoice *send* tool: sending a real invoice to a real
customer stays a human action inside Fiken.

## Provider constraints that shape the client

`apps/api/src/integrations/fiken.ts`:

- **Single concurrent request.** Fiken allows one in-flight API request per
  credential; violations can 429 and repeated violations can get the token
  banned. `FikenClient` serializes every provider call through a per-connection
  promise chain in the API process. Keep it that way — do not parallelize Fiken
  calls, and do not add automatic 429 retries.
- Pagination is `page`/`pageSize` (max 100) with `Fiken-Api-Page*` response
  headers, projected as a `page` fact on list results.
- Responses are read bounded (2 MiB); `attachments`/`documents` blobs are
  stripped from projected records; creation endpoints answer 201 with a
  `Location` header whose trailing id is parsed host-side.
- Every operation writes an `audit_events` row (`fiken.<operation>`) with the
  connection receipt, mirroring the Slack bot client.

## Fiken's terms

Fiken's API docs state that third parties integrating on behalf of their
customers must use OAuth2; personal API tokens are only for Fiken customers
integrating their own accounting, and using them in third-party applications
violates Fiken's terms. That is why the UI leads with the OAuth lane and folds
the token form behind an explicit toggle. A newly registered Fiken app is
limited to 5 users until Fiken grants production status (api@fiken.no; Fiken
asks for 2–3 real onboarded users first). API module access is a paid Fiken
feature (ordered inside Fiken); a valid credential with API access to no
company fails verification with a pointed message.

## Testing

Fiken rejects non-HTTPS redirect URLs, so testing the OAuth flow against a
local stack needs an HTTPS tunnel. Do not tunnel the whole API (a `local`-mode
deployment is auth-free): run
`bun scripts/dev-fiken-callback-forwarder.ts <api-port>` and point the tunnel
at the forwarder, which exposes only the exact callback path. Set
`OPENGENI_PUBLIC_BASE_URL` to the tunnel URL (so start/callback build a
consistent `redirect_uri`) and `OPENGENI_WEB_BASE_URL` to the local web app
(so the finishing redirect returns there).

`apps/api/test/fiken.test.ts` covers token verification, the token install
route (create/reconnect/422s/credential-bundle shape), the OAuth start and
callback routes (authorize-URL shape, Basic-auth code exchange, state replay
and tampering, provider denial, in-place re-authorization, broker refresh with
rotating refresh tokens), tool connection resolution across both kinds,
company-slug resolution and validation, request serialization, 401→
`needs_reauth` vs 429/500 non-poisoning, Location-id parsing, draft
idempotency, and audit rows — all against an injected Fiken fetch double.
Web connect-plan/health logic is covered in
`apps/web/src/lib/capabilities.test.ts`.
