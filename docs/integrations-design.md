# Integrations: connections, token broker, and the MCP OAuth client

**Audience:** maintainer. **Status:** design locked (I0, 2026-07-03). Implementation lands in phases I1–I6 (program tracker lives with the orchestrator; phase acceptance criteria in §12).

## 1. Overview

OpenGeni gains a first-class integrations layer: users connect external services (one browser OAuth round-trip or a pasted key), agents use them through MCP, and credentials live behind a single broker that no model, sandbox, or workflow payload can see.

Strategy (decided): **MCP-first.** We implement the MCP authorization spec (revision 2025-11-25) *client side* once; every vendor-hosted remote MCP server becomes installable by URL or domain with zero OpenGeni-side provider registration. OpenGeni-registered provider apps (GitHub App today, Slack bot later) are a selective add-on, not the default path. No third-party iPaaS in the core.

Three layers, kept distinct throughout this doc:

| Layer | Question | Owner |
|---|---|---|
| Acquisition | How does a credential come to exist? | OAuth flows, manual entry, app installs |
| Storage | Where does it live, who may read it? | `connections` table + AEAD envelope |
| Use | How does a tool call get authenticated? | Token broker at MCP request time |

## 2. The `connections` model

One table is the spine for all external credentials, declared in `packages/db/src/schema.ts` following house style (camelCase fields → snake_case columns, `accountId` + `workspaceId` on every workspace-scoped table for RLS), with SQL migration `0039_connections.sql` in `packages/db/drizzle/` including the standard `ENABLE`/`FORCE ROW LEVEL SECURITY` + `workspace_isolation` policy via `opengeni_private.workspace_rls_visible(account_id, workspace_id)` and a `current_schema()` guard (embed-schema compatible).

```
connections
  id                      uuid pk default gen_random_uuid()
  account_id              uuid not null → managed_accounts, cascade
  workspace_id            uuid not null → workspaces, cascade
  subject_id              text nullable — null ⇒ workspace-shared (bot identity);
                          set ⇒ personal, on-behalf-of that subject
  provider_domain         text not null — canonical domain key ("slack.com", "linear.app");
                          first-party pseudo-providers namespaced ("opengeni:github-app")
  kind                    'oauth2' | 'api_key' | 'app_install' | 'delegated'   (CHECK)
  status                  'active' | 'needs_reauth' | 'revoked' | 'error'       (CHECK)
  credential_encrypted    text not null — AEAD envelope (§3), single JSON bundle
  granted_scopes          jsonb string[] default [] — as granted, not as requested
  expires_at              timestamptz nullable — access-token expiry
  last_refresh_at / last_used_at / last_error
  version                 integer not null default 1 — CAS guard (§4)
  metadata                jsonb object default {} — account handle/email, AS issuer,
                          resource URI, PRM snapshot, display name; NEVER secret material
  created_by_subject_id / updated_by_subject_id
  created_at / updated_at
Indexes: (workspace_id, provider_domain, status), (workspace_id, subject_id, provider_domain),
         (workspace_id, kind), (workspace_id, expires_at)
```

Decisions baked in:

- **No uniqueness on `(workspace, subject, provider, kind)`** — providers legitimately allow multiple accounts per workspace. Reconnecting an existing connection updates it in place (CAS); connecting an additional account creates a new row. Dedupe by external account identity, if ever needed, keys on `metadata.externalAccountId` in SQL, not schema.
- **No `pending` status** — in-flight OAuth grants are stateless (signed state, §5.2); a row is created only on successful callback.
- `credential_encrypted` is the only column that may hold secret material; `metadata` is UI-renderable verbatim. API list/get helpers never select `credential_encrypted`.
- Revoking sets `status='revoked'` (row kept for audit) and best-effort calls the provider's revocation endpoint when known.

**Ownership doctrine.** Default new providers to workspace-shared (`subject_id` null) bot-style identity — survives user churn, matches agent workloads. Personal connections are for act-as-a-person tools; the token's native provider-side permissions are the authorization boundary. Runtime resolution of subject-owned rows is deferred to I5 (§7 landmine: the worker currently runs under a synthetic subject).

## 3. Credential encryption

Reuse the existing AES-256-GCM envelope as-is: `encryptEnvironmentValue`/`decryptEnvironmentValue` in `packages/db/src/environment-crypto.ts` (format `v1:<base64 iv>:<base64 ciphertext||tag>`), keyed by `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` via `environmentsEncryptionKeyBytes` in `packages/config/src/index.ts`. No new key. Unlike capability headers (per-header ciphertext map), `connections.credential_encrypted` stores **one JSON bundle**:

```json
{ "access_token": "…", "refresh_token": "…", "token_type": "Bearer",
  "expires_at": "…", "resource": "https://…", "scope": "read write" }
```

Fail closed when the key is missing: API credential writes return 503 (capability-enable style); broker reads throw without echoing secret values. Decryption happens in exactly two places — the broker's decrypt-read helper and the connections domain's refresh/revoke internals. No decrypt helper is exported to app code; the SDK and React packages never see these types (publish-closure guard applies).

## 4. Token broker

The single seam where a connection becomes request-auth material. Two halves:

**DB-backed resolver** (mirrors the Codex pattern in `packages/db/src/codex-token-resolver.ts` exactly): decrypt-read accessor scoped for run use; refresh via OAuth `refresh_token` grant against the stored AS token endpoint; **`(id, version)` CAS** on write with `version + 1` (losers of a cross-process race re-read and adopt the winner's tokens — refresh tokens rotate and can be one-time-use); process-local single-flight keyed `id:version`.

**Runtime injection** — a custom `fetch` on `MCPServerStreamableHttp`, NOT static `requestInit.headers`. Rationale: `mcpServerRequestInit` in `packages/runtime/src/index.ts` is awaited once at construction, so static headers cannot refresh mid-run; the SDK's custom-fetch seam is already proven by the Codex Apps sanitizing fetch. Contract:

```ts
type ResolveConnectionCredentialResult =
  | { status: "ok"; headers: Record<string, string>; connectionId: string; expiresAt?: Date | null }
  | { status: "auth_needed";
      reason: "missing_connection" | "expired" | "insufficient_scope" | "refresh_failed";
      providerDomain: string; scopes?: string[]; resource?: string; authorizationUrl?: string }
```

`PrepareToolsOptions` gains `resolveCredential` and `onAuthNeeded`; `prepareAgentTools` composes a broker fetch for servers carrying a `connectionRef`: resolve → inject headers → on 401 force-refresh once and retry → on 403 `insufficient_scope` emit `auth_needed` (§6). Wired from the worker (`apps/worker/src/activities/agent-turn.ts`) alongside `onRuntimeEvent`.

Broker rules:

- Resolution requires `workspace_id` match and (`subject_id IS NULL` or `= ctx.subjectId`) — re-checked at the broker, not just the API layer.
- Failure is data, not throw: `auth_needed` flows into §6; a dead credential is user-recoverable, never a turn crash.
- Every resolve updates `last_used_at` and emits an audit record (connection id, run id, outcome — never token material).
- 403 step-up must NOT poison good credentials: `insufficient_scope` does not flip status to `needs_reauth`; only an unusable refresh grant does.
- Settings carry only `connectionRef` (non-secret pointer); the `mcpServers` entry schema in `packages/config/src/index.ts` gains an optional `connectionRef { connectionId?, providerDomain, kind?, scopes?, resource?, subjectScope? }`.

Tokens therefore never appear in: `session_turns.tools`, `session_events.payload`, `agent_run_states`, Temporal signals/activity inputs, sandbox env, model context, SDK/React client types, or logs. The event sanitizer (`packages/db/src/event-payload-sanitizer.ts`) already strips `mcpServers[].headers`/`headersEncrypted`; it gains guards for auth-flow fields.

## 5. MCP OAuth client (spec rev 2025-11-25)

### 5.1 Flow

```
DISCOVER   probe server URL unauthenticated
           → 401 + WWW-Authenticate: parse resource_metadata URL + scope hint
           → RFC 9728 Protected Resource Metadata (well-known fallback probing)
           → pick AS; RFC 8414 / OIDC-discovery metadata (both well-known path orders)
           → REQUIRE code_challenge_methods_supported ∋ S256, else abort with clear error
REGISTER   priority: (1) operator pre-registered creds for this AS
           (2) CIMD if client_id_metadata_document_supported — client_id is our hosted
               metadata URL (§5.3)
           (3) DCR (RFC 7591) if registration_endpoint — minted client_id stored per AS
           (4) manual client-credential entry in UI
AUTHORIZE  authorize URL: PKCE S256, state = signed payload (§5.2),
           resource = canonical MCP server URI (RFC 8707, ALWAYS sent),
           scope = requestedScopes when supplied (step-up), else 401-challenge
           scope if present, else PRM scopes_supported
           → browser → provider consent → redirect to callback
CALLBACK   GET /v1/integrations/oauth/callback?code&state
           → verify signed state (single-use nonce, TTL ~10 min)
           → token request with code_verifier + resource
           → encrypt bundle, insert active connection, record granted scopes/issuer
VERIFY     one authenticated tools/list; record tool inventory in metadata
STEP-UP    runtime 403 error="insufficient_scope" → tool.auth_needed → re-AUTHORIZE with
           widened scope on user click; new grant supersedes via CAS update
```

### 5.2 Stateless grant state (decision)

No pending-grant table. The `state` parameter is a **signed, time-limited payload** using the established `createSignedState`/`verifySignedState` pattern from `@opengeni/github`, with a dedicated `integrationsStateSecret`: `{ workspaceId, accountId, subjectId, providerDomain, resource, requestedScopes, authorizeScopes, encryptedPkceVerifier, clientId, tokenEndpoint, authorizationServer, issuer, returnPath, nonce, iat }`. The PKCE verifier is **encrypted** (environments key) inside the signed state — state transits browser URLs and provider logs, and a plaintext verifier there would defeat PKCE's interception protection. Single-use is enforced by inserting the consumed nonce into `integration_oauth_state_nonces` with a short TTL; the primary key makes replay fail across API instances. This survives multi-instance API deployments (the callback may land on any instance) — which is also why a random per-process fallback secret is forbidden: `integrationsStateSecret` is required whenever integrations are enabled outside local dev.

The callback route must NOT call `requireAccessGrant` — a browser redirect carries only `code`+`state`. It trusts exclusively the verified, unexpired signed state minted by the authenticated start route.

### 5.2.1 Authorization-server clients

DCR-minted OAuth clients are deployment-wide authorization-server identity, not per-workspace user credentials. They live in `integration_oauth_clients`, keyed by AS issuer, with `client_secret` encrypted under the environments key when present. This keeps one DCR client reusable across many workspace connections to the same AS, while the actual access/refresh tokens remain in workspace-scoped `connections.credential_encrypted`. Operator pre-registered clients are read from `OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON` and are not copied into Postgres.

### 5.3 Our client identity (CIMD)

Served publicly at `GET /v1/integrations/oauth/client-metadata.json`:

```json
{ "client_id": "<this document's exact URL>", "client_name": "OpenGeni",
  "redirect_uris": ["<publicBaseUrl>/v1/integrations/oauth/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"] }
```

`client_id` byte-matches its serving URL. Base URL is `settings.publicBaseUrl` (`OPENGENI_PUBLIC_BASE_URL`, already required in managed mode); HTTPS is enforced when integrations are enabled outside local dev. Per-deployment documents differ by construction, so staging/prod/embedded hosts each get their own client identity automatically.

### 5.4 Client-side security requirements

- PKCE S256 always; refuse ASes not advertising it.
- `state` signed, single-use, TTL-bound, workspace+subject-bound; callback validates all of it.
- `resource` (RFC 8707) on both authorize and token requests regardless of AS support.
- Exact-match redirect URI only; never follow AS-supplied alternative redirects.
- SSRF guard on PRM/AS-metadata/token-endpoint fetches: no private-range targets unless running in local/test or `OPENGENI_INTEGRATIONS_ALLOW_PRIVATE_NETWORK_TARGETS=true`.
- No token passthrough: tokens minted for an MCP server go only to that server; our own first-party MCP servers keep validating audience on inbound tokens.
- Token responses stored, never logged.

## 6. Tool↔connection contract and `tool.auth_needed`

MCP server settings entries carry the optional `connectionRef` (§4). Behavior when the broker returns `auth_needed`:

- **Tool call time:** the call short-circuits before any network I/O; a `tool.auth_needed` session event is published, and the model receives an MCP error result (`isError: true`, "Authentication required — a connection link was posted to the session") so it can adapt. The turn continues; **this is not a `session.requiresAction` pause** (approval gates persist run state and block; a missing connection is a tool-level condition). If product later wants blocking OAuth, that's an explicit extension.
- **Connect/tools-list time:** connection-missing servers are treated as best-effort (event + skip), not a strict-connect turn failure — today required servers fail the turn via strict `connectMcpServers`, which is wrong for auth-recoverable conditions.

Event: `"tool.auth_needed"` added to `SessionEventType` in `packages/contracts/src/index.ts` AND the hand-written mirror in `packages/sdk/src/types.ts` (parity test pins them), plus the structural flush set in `apps/worker/src/activities/streaming.ts` so the chip appears promptly. Payload: `{ serverId, toolName?, providerDomain, connectionId?, reason, scopes?, resource?, authorizationUrl?, subjectId? }` — no verifiers, secrets, or raw provider responses; `authorizationUrl` only when free of secret material. Timeline projection (`packages/react/src/timeline/projection.ts`) renders a waiting-tone notice with a Connect action; copy is plain language (provider name + "needs a connection"/"needs additional access") — no kind enums, no "CIMD"/"DCR", no status slugs.

## 7. Access control

New permissions `connections:read` (metadata/status only — never secrets) and `connections:write` (create/update/delete/revoke/start-OAuth), added in all three places the permission registry lives: `Permission` in `packages/contracts/src/index.ts`, `KNOWN_PERMISSIONS` in `packages/sdk/src/types.ts`, `allWorkspacePermissions` in `packages/db/src/index.ts` (SDK parity/coverage tests enforce this). `workspace:admin` implies both, per `hasPermission` semantics in `packages/core/src/access/index.ts`.

Subject-ownership is enforced in helper predicates + domain logic (DB RLS is account/workspace-scoped and cannot see the caller subject): readers see shared rows plus their own subject rows; admins may revoke subject-owned rows but not use them or read beyond provider + status; the broker re-checks at resolve time.

**Landmine (drives phasing):** the worker calls prepareTools with the synthetic subject `worker:first-party-mcp`, not the human who connected. Until a real initiating subject is threaded through runs (I5), `connectionRef` resolution at runtime accepts **workspace-shared connections only**.

## 8. API surface

Route module `registerConnectionRoutes` in a new `apps/api/src/routes/` file, registered in `apps/api/src/app.ts` beside capabilities/codex/social:

- `GET/POST /v1/workspaces/:workspaceId/connections` (+ `GET/PATCH/DELETE …/:connectionId`) — gated `connections:read`/`connections:write` via `requireAccessGrant`.
- `POST /v1/workspaces/:workspaceId/connections/oauth/start` — `connections:write`; runs DISCOVER+REGISTER, mints signed state, returns the browser authorize URL.
- `GET /v1/integrations/oauth/callback` and `GET /v1/integrations/oauth/client-metadata.json` — added to the exact-path public exemptions in `apps/api/src/http/auth.ts` (alongside the GitHub callbacks). Only these two paths; no broad `/v1/integrations/*` exemption.

Config additions in `packages/config/src/index.ts`: `integrationsEnabled` (`EnvBoolean.default(false)`, env `OPENGENI_INTEGRATIONS_ENABLED`), `integrationsStateSecret` (required when enabled outside local dev), `integrationsAllowPrivateNetworkTargets` (`OPENGENI_INTEGRATIONS_ALLOW_PRIVATE_NETWORK_TARGETS`, default false), and `integrationsOauthClientsJson` (`OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON`, operator pre-registered clients keyed by AS issuer/URL). Boot validation: enabled + managed mode ⇒ `publicBaseUrl` present and HTTPS.

## 9. UX surfaces (built in I3; contract fixed here)

- **Integrations page** (workspace settings): catalog grid (search, verified/community badges), connected list with health (status, expiry, owner badge workspace/personal, last used), connect/disconnect, add-by-URL, add-by-domain (I4), paste-a-key rendering catalog credential facts (setup deep link + text).
- **Connect flow:** click → confirmation modal showing the *domain* and requested scopes → browser OAuth → return with the connection live. Domain confirmation is mandatory for registry-sourced and agent-initiated connects.
- **In-session:** the `tool.auth_needed` chip folds into the turn per existing timeline fold rules.

## 10. Discovery & catalog (I4)

- Source-of-truth order: (1) the service's own well-known signals probed at add-by-domain time, (2) a **vendored, reviewed snapshot** of the integrations.sh registry (MIT) — import pipeline re-verifies `detected` entries (probe endpoint, confirm PRM) and demotes the rest to `community`. Never live-consume the registry at request time; snapshots are versioned with import provenance.
- Catalog rows extend `capability_catalog_items` with surface type, MCP URL, transports, credential facts, tier, provenance.
- Phase I4 imports use `scripts/import-integrations-catalog.ts` against a reviewed snapshot or precomputed `importRows` file. Imported rows are global `source: "registry"` capability rows keyed by `(provider_domain, mcp_url)`, linked to `import_batches`, and stale-marked on removal rather than deleted. Logo URLs are fetched at import time and stored as self-hosted object-storage assets (`logo_asset_path`); third-party logo URLs are not served from the catalog.
- **Agent registry tool:** a first-party tool letting the agent query the catalog/domain probe for capabilities it lacks; hits yield the `tool.auth_needed`-style elicitation with mandatory human domain confirmation. The agent can never silently add a server.

## 11. Legacy credential sites — convergence

| Site | Plan |
|---|---|
| `capability_installations.config.headersEncrypted` | Kept for legacy/static header installs. New installs set `config.connectionRef` (validated against workspace + subject policy in `packages/core/src/domain/capabilities.ts`, stripped from untrusted caller config like the reserved header keys). `EnabledMcpCapabilityServer` + `listEnabledMcpCapabilityServers` + `settingsWithMcpCapabilityServers` in `packages/db/src/index.ts` pass the ref through without decrypting; an item with `authModel` satisfies its requirement with either headers or a ref. Backfill decided in I6 with reasons logged. |
| `github_installations` | Becomes `kind: 'app_install'` in I6; installation-token minting moves behind the broker. Unchanged until then. |
| `codex_subscription_credentials` | Stays separate (account-level rotation semantics, own resolver). Not a goal of this program. |
| First-party delegated bearer | Unchanged — identity plumbing, not an external credential. |
| `social_connections` | Superseded for future use; existing rows untouched until a consumer needs migration. |
| `ConnectionCredentialsPort` | Extended in I5 with `resolveConnection({provider, workspaceId, subjectId})`; OpenGeni's own table is the default implementation; host-provided implementations take precedence (embed doctrine: host owns connections). |

## 12. Security invariants and phase acceptance

Testable gates (each mapped to tests in I1/I2):

1. No raw token in logs, session rows, Temporal payload types, sandbox env, or model context — asserted by a full-flow test that scans sinks.
2. PKCE S256 + signed single-use state + RFC 8707 `resource` on every flow; refuse non-S256 ASes.
3. No token passthrough; per-server audience binding.
4. The broker's decrypt-read is the sole decrypt path for `credential_encrypted`; API reads never select the column.
5. Subject-owned rows unusable by other subjects, including via broker.
6. Human confirms the target domain for every agent- or registry-initiated connect.
7. Refresh races are CAS-safe (`(id, version)`); replayed state rejected.

Phase acceptance:

- **I1:** manual `api_key` connection → real MCP tool call on staging; token absent from all sinks (scripted check); CRUD + permissions enforced; CAS refresh + single-flight unit-tested; `tool.auth_needed` renders in the timeline.
- **I2:** ≥2 real third-party remote MCP servers connected via the full browser flow on staging (CIMD exercised on at least one; DCR fallback on another where offered); refresh observed live; disconnect revokes; step-up exercised.
- **I3:** non-technical path — browse → connect → agent uses tool — live with zero manual config; `auth_needed` chip → connect → next turn proceeds.
- **I4:** domain typed → verified MCP resolved → one-click connect; agent self-discovers a missing capability and elicits; snapshot import pipeline documented + rerunnable.
- **I5:** two subjects, same tool, distinct tokens used correctly; embedded-host credential source substitutes cleanly.
- **I6:** Slack bot connect end-to-end; GitHub App on the spine; security review passed; docs shipped (`bun run check:docs-refs` green, `docs/architecture.md` updated).

## 13. Build order (I1) and known landmines

Build order: contracts/config scaffolding (event type + permissions + `connectionRef` schema, SDK mirrors) → DB schema + `0039_connections.sql` + helpers/tests → broker resolver (single-flight, CAS, 401-retry-once, 403→auth_needed) → API routes + public exemptions + signed state → capability `connectionRef` threading → runtime broker-fetch composition → `tool.auth_needed` events/projection/sanitizer → worker wiring → `bun run typecheck && bun test && bun run check:docs-refs`.

Landmines (from the I0 fit audit — respect these):

- SDK stays zero-runtime-dependency and hand-mirrored; never import contracts/db/config into `@opengeni/sdk`/`@opengeni/react` (publish-closure guard).
- `zod` vs `zod/v4` split: contracts/config use `zod`; MCP-SDK-facing helpers use `zod/v4`; keep new schemas consistent with their package. Bun bundling history makes this non-cosmetic.
- Better Auth/`pg` must stay in `apps/api/src/auth` (workspace-billing static guard).
- Static-header capability path keeps working unchanged; `connectionRef` is additive.
- Migration follows the RLS + `current_schema()` policy-guard pattern; prefer targeted grants over `IN SCHEMA public`.
- `packages/db/src/schema.ts` and `packages/config/src/index.ts` are large shared contracts: narrow edits, no reordering.
