# Fiken connector (first-party)

OpenGeni's first-party connector for [Fiken](https://fiken.no), the Norwegian
small-business accounting service. Phase 1 is the **verified personal-API-token
connector**: a workspace admin pastes a Fiken personal API token, OpenGeni
verifies it against Fiken and stores it encrypted, and the agent reaches Fiken
through host-side `fiken_*` tools on the first-party MCP surface. No Fiken data
or credential ever enters the sandbox.

## What phase 1 is

- **One workspace-shared connection.** `POST /v1/workspaces/:id/connections/fiken/install`
  (SDK `installFikenConnection`) takes `{ apiToken, defaultCompanySlug?, connectionId? }`,
  verifies the token by listing its accessible companies, and stores a
  workspace-owned row in the generic `connections` table
  (`providerDomain: "fiken.no"`, `kind: "api_key"`, credential bundle
  `{ headers: { authorization: "Bearer …" } }`, metadata
  `credentialRole: "fiken_api_token"` plus the bounded verified company list).
  Passing `connectionId` rewrites an existing Fiken row in place (reconnect /
  token replacement). Personal ("Connect only for me") ownership is deliberately
  **not** part of phase 1 — it arrives with the OAuth connector and its
  delegation snapshots.
- **Verified at paste time.** A bad token fails the install route with a
  specific 422 instead of failing at first tool use. Tokens are created in
  Fiken under *Rediger konto → API*; they never expire, so there is no refresh
  machinery — a Fiken 401 marks the connection `needs_reauth` and the fix is a
  fresh pasted token.
- **Company scoping.** Fiken URLs are per-company (`/companies/{slug}/…`). Every
  tool takes an optional `companySlug`; the connection's `defaultCompanySlug`
  (auto-set when the token sees exactly one company) fills it in, and ambiguity
  is an error that lists the available slugs.
- **Catalog tile.** `api:fiken` (`surfaceType: "first_party_fiken"`) in the
  capabilities catalog; enablement is derived from the workspace connection row,
  and the web connect sheet uses the verified paste-a-token flow
  (`capabilityConnectPlan` mode `fiken_api_token`).

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

There is deliberately no invoice *send* tool in phase 1: sending a real invoice
to a real customer stays a human action inside Fiken.

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
customers must use OAuth2; personal API tokens are for Fiken customers
integrating their own accounting. Phase 1's paste-a-token flow targets exactly
that self-integration case (a workspace connecting its own Fiken). A hosted
multi-tenant offering should move to the phase 2 OAuth connector (registered
Fiken app, authorization-code flow, refresh tokens, per-user consent, and
personal ownership via delegation snapshots), which also lifts the 5-user
development-app limit through Fiken production approval (api@fiken.no).
API module access is a paid Fiken feature (ordered inside Fiken); a valid
token with no API-enabled company fails verification with a pointed message.

## Testing

`apps/api/test/fiken.test.ts` covers token verification, the install route
(create/reconnect/422s/credential-bundle shape), tool connection resolution,
company-slug resolution and validation, request serialization, 401→
`needs_reauth` vs 429/500 non-poisoning, Location-id parsing, draft
idempotency, and audit rows — all against an injected Fiken fetch double.
Web connect-plan/health logic is covered in
`apps/web/src/lib/capabilities.test.ts`.
