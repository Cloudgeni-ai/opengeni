# Browser login session sets

Audience: application, security, and deployment operators. This document is the
canonical authority for provider-neutral browser login slots, actor switching,
compatibility modes, and self-hosted rollout.

## Boundary

A browser session set lets one browser installation hold up to eight independently
revocable human login slots and makes exactly one slot the selected product actor.
It multiplexes authentication sessions; it does not merge canonical humans, link
login bindings, change organization or workspace authority, or select a tenant.
Canonical-human and verified-binding authority remains in
[`organization-tenancy.md`](organization-tenancy.md). A selected human receives only
the organizations, workspaces, sessions, and capabilities that the ordinary access
resolver authorizes for that human.

The repository defaults to `legacy`. Applying migration 0362 does not activate
session sets, and repository delivery does not authorize a staging or production
mode change.

## Authority and persistence

Migration `packages/db/drizzle/0362_managed_auth_session_sets.sql` is a rolling
migration. It stamps every Better Auth session with the exact canonical login
binding and its revision, then adds:

- `managed_auth_browser_installations`: hash-only installation authority with a
  30-day idle and 180-day absolute expiry;
- `managed_auth_session_sets`: hash-only set authority and CSRF proof, monotonic
  generation and actor epoch, exact selected slot, and revocation state;
- `managed_auth_login_slots`: exact Better Auth session, canonical human, login
  binding, and identity/auth/binding revision stamps plus safe display metadata;
- `managed_auth_login_transactions` and `managed_auth_login_return_intents`:
  one-use, ten-minute add/re-auth authority and bounded same-origin return paths;
- `managed_auth_session_set_operations`: append-only, secret-free idempotency
  evidence keyed by operation UUID and exact request digest; and
- `managed_auth_actor_mutation_leases`: short, renewable current-epoch leases
  that fence tenant-bound writes through final settlement; and
- `managed_auth_login_transaction_rate_limits`: global, secret-hashed client,
  and per-set fixed-window buckets shared by every API replica for Add/re-auth
  admission.

The raw browser authority and transaction secret exist only in `HttpOnly` cookies.
PostgreSQL stores their SHA-256 digests. Session-set authority uses `SameSite=Lax`,
the transaction cookie uses `SameSite=Strict` and the narrow session-set path, and
both are `Secure` when the public base URL is HTTPS. Better Auth provider session
tokens and provider session identifiers never enter the browser-safe session-set
projection.

All eight tables use FORCE RLS. The restricted runtime role has no direct table
DML; it reaches the lifecycle only through target-schema-local, PUBLIC-revoked,
schema-pinned `SECURITY DEFINER` routines. The selected-slot foreign key includes
the session-set id, operation evidence is append-only, and the migration/runtime
posture tests prove those constraints under the restricted role and a dedicated
schema.

## Public protocol

The bounded public shape is in
`packages/contracts/src/managed-auth-session-sets.ts`; the optional browser client
is `@opengeni/sdk/accounts`; and the headless React controller is
`@opengeni/react/accounts`. The API owns these product routes before Better Auth's
wildcard handler:

- `GET /v1/auth/session-set` creates or reads a safe projection without durable
  renewal side effects;
- `POST /v1/auth/session-set/bootstrap` adopts the exact ambient legacy session
  once during `dual` rollout; competing first-adoption attempts serialize, and a
  session already owned by any live slot cannot transfer or re-key set authority;
- `POST /v1/auth/session-set/transactions`,
  `POST /v1/auth/session-set/transactions/email-password`,
  `POST /v1/auth/session-set/transactions/social`, and
  `DELETE /v1/auth/session-set/transactions/:transactionId` own isolated add or
  exact-slot re-authentication;
- `POST /v1/auth/session-set/select`, `logout-one`, and `logout-all` own explicit
  actor and revocation changes; and
- `POST /v1/auth/session-set/deep-link/resolve` checks one supported same-origin
  workspace/session route against every live slot and returns only `current`, a
  safe slot summary for `switch_required`, or indistinguishable `unavailable`.

An empty broker GET remains cookie-only and nondurable. Its first exact Add at
generation/actor epoch `1/1` atomically creates the installation, empty set,
transaction, and operation receipt. Re-auth or a noninitial fence cannot
materialize authority, and exact replay cannot duplicate any of those rows. An
empty set expires with that ten-minute transaction and is physically purged with
its unauthenticated evidence. Every set admits at most one live transaction. A
secret-hashed per-client bucket allows eight admissions per ten minutes, a
deployment-global bucket allows 500, and each set allows sixteen per UTC day.
Those durable bounds cover both unauthenticated authority rotation and repeated
begin/cancel loops on an authenticated set, even with spoofed client keys.

Every mutation requires the exact API-contract header, an allowed exact origin,
valid Fetch Metadata, JSON content type, a session-bound CSRF proof, the current
actor epoch, expected-generation compare-and-swap, and an operation UUID. Exact
replay returns the durable receipt before stale generation or provider-session
checks; reusing an operation UUID with a different digest fails closed. A lost
response is therefore reconciled by replaying the same operation, never by
inventing another id.

Add and re-auth open `/account-auth` in a same-origin popup. The server strips all
ambient provider cookies and authorization headers before the isolated Better Auth
attempt. The opener receives only the transaction UUID over an exact-origin,
exact-window `postMessage`; it then rereads server authority. Add leaves the current
slot selected. Re-auth proves the transaction's exact slot, human, login binding,
and captured revisions before replacing that slot's provider session.

Configured Google and GitHub sign-in starts through the same fenced transaction.
The OAuth state retains only a server-side transaction digest and exact generation,
actor epoch, authority hash, provider, and safe popup return. The callback preserves
only Better Auth's state cookie, resolves the exact provider login binding, adopts
the newly created session before redirecting to `/account-auth`, and then removes
the ambient provider session cookie. A callback cannot select another browser slot,
and automatic email-match account linking remains disabled.

The session-set-capable signed-out surface uses that isolated Add path for sign-in
in both `dual` and `broker`. Account creation and verification resend remain
available beside it. Those provider routes may create or recover an account, but
when a session-set authority cookie is present the API scrubs any automatic
provider session cookie; the new account must enter the set through isolated Add
before it can become a selectable actor.

Logout-one names both the removed slot and an active replacement slot or explicit
`null`. Logout-all revokes only this browser set. If selection becomes invalid,
the projection becomes neutral `actor_change_required`; the server never silently
selects another human.

## Browser actor transition

The React controller implements
`preflight -> blocked|committing -> loading -> ready|recoverable_error`. Real
draft, upload, and in-flight mutation inspectors run before commit. The web shell
then:

1. removes the old tenant projection from view;
2. aborts finite requests and established response bodies or SSE streams owned by
   the old epoch;
3. clears tenant-bound caches and recreates credentials and SDK clients;
4. requires the new server actor epoch on responses and SSE frames; and
5. double-confirms the authoritative projection before returning to `ready`.

The API holds a renewable actor-mutation lease for tenant-bound writes, validates
it at final commit, and terminates a process that cannot renew before its durable
lease could expire. Cross-tab `BroadcastChannel` messages contain only an epoch
hint; receiving tabs immediately neutralize their projection and reread authority.
Stale results are suppressed by monotonic `BigInt` generation/epoch comparisons.
Logout-all, expiry, or invalid-authority recovery may rotate the shared HttpOnly
authority back to a lower clock; an explicit neutral reconciliation advances an
SDK read epoch, then accepts that lower clock only after two sequential no-store
reads both prove it without regressing each other. Pre-reconciliation reads cannot
restore the old clock, and adopting the new authority clears every retained
mutation admission.

Same-human slots still take this full boundary. A second login binding cannot
reuse or duplicate another slot's authority, and selecting it still advances the
actor epoch so binding-private state cannot survive.

## Security invariants

- Browser projections contain bounded display name, verified email claim, slot
  UUID/state, counters, and CSRF proof only. They contain no Better Auth token,
  provider session id, return-intent secret, canonical identity id, login-binding
  id, organization id, or workspace id.
- Better Auth automatic account linking remains disabled. Slot identity comes
  only from the isolated authenticated provider result and canonical binding
  lookup; never from URL, email selection, local storage, or callback parameters.
- Ordinary selected-session reads are side-effect free until a fenced actor lease
  is held. Revision drift, password recovery, provider revocation, or canonical
  binding change invalidates only the affected slot.
- Return intents accept only exact query-free and fragment-free UUID route shapes
  for sessions and workspaces, capped at 2,048 UTF-8 bytes. Missing and forbidden
  resources are indistinguishable before switching.
- Wildcard provider routes use a fixed method/path allowlist, strip ambient
  request cookies and authorization, and remove provider secrets from JSON
  responses. Broker mode clears provider cookies. With session-set authority,
  dual mode preserves only an active set's exact selected compatibility mirror
  and otherwise clears the provider cookie instead of accepting an unselected
  wildcard credential. Any provider session minted by those unselected broker or
  session-set-authority lifecycles is born expired and synchronously deleted before
  the response returns; cleanup failure fails the provider request closed and leaves
  a bounded-reaper-eligible row rather than a live credential. A legacy dual client
  without session-set authority keeps ordinary Better Auth behavior until explicit
  bootstrap. Selected product-session capabilities remain on the fenced product routes.
- Session-set and provider-auth responses are `no-store`; secret material is
  excluded from operation evidence, errors, browser events, logs, and retained
  browser evidence.
- The API reaps bounded batches of expired sets and unadopted isolated provider
  sessions every minute. Process death between provider authentication and SQL
  adoption therefore leaves no unbounded live credential.

## Compatibility modes

| Mode | Browser authority | Legacy Better Auth cookie | Intended use |
| --- | --- | --- | --- |
| `legacy` | Session-set routes unavailable | Ordinary Better Auth behavior | Default and rollback-compatible pre-activation state |
| `dual` | Session set is authoritative after explicit bootstrap/switch | Exact selected slot is mirrored for new/old binary coexistence | Measured migration and client adoption |
| `broker` | Session set is the only browser actor authority | Ambient legacy cookie is neither admitted nor minted | Final activation after dual acceptance |

In `dual`, an existing legacy session may bootstrap exactly once into its
installation set. A stale tab holding the same provider cookie cannot bootstrap a
second authority, rotate the original installation/set hashes, or inherit its
other slots; it must reconcile from current browser authority. Once an actor epoch
has advanced, headerless requests fail closed: a stale pre-switch page and a fresh
legacy page are otherwise indistinguishable. Old binaries can coexist while migration 0362 runs because its
insert trigger supplies the new non-null binding stamps, but all API replicas and
the served web bundle must be on the session-set-capable release before selecting
`dual` or `broker`.

Setting `broker` is a deployment action, not a database migration. Do not mix
modes across API replicas. A rollback from `dual` to `legacy` retains the mirrored
selected legacy session but makes additional slots dormant. After `broker`, first
return to a fully healthy `dual` generation and re-establish an explicit selected
legacy mirror; do not restart an arbitrary old image or run a down-migration.

## Rollout and rollback

Repository readiness and deployment activation are separate approvals:

1. Keep `OPENGENI_MANAGED_AUTH_SESSION_SET_MODE=legacy`. Apply migration 0362
   through the owner migration job, provision the restricted runtime grants, and
   require migration-ordinal/schema-contract and runtime-posture checks.
2. Deploy the same session-set-capable API and web generation to every replica.
   Verify client config still reports `legacy` and ordinary sign-in/onboarding.
3. With a fresh deployment authorization, move every replica to `dual`. Exercise
   legacy adoption, two actual users, add without selection, A/B switching,
   re-auth, logout-one/all, cross-tab conflict, deep-link recovery, and late-epoch
   suppression. Monitor typed conflict/outcome-unknown rates and reaper failures.
4. Hold `dual` until the complete browser population and operational window are
   accepted. Only a separate fresh authorization may move every replica to
   `broker`.
5. In `broker`, repeat the same acceptance from a browser with no legacy cookie.
   Keep migration 0362 and its evidence tables; rollback is a mode/configuration
   transition and fix-forward application release, never destructive SQL.

No repository test, PR merge, or migration application authorizes step 3 or 4.

## Self-hosting

Session sets apply only to `OPENGENI_PRODUCT_ACCESS_MODE=managed`. Local and
configured deployments should leave the mode at `legacy`. A managed self-hosted
installation must additionally:

- serve web and API from one canonical HTTPS origin and set
  `OPENGENI_PUBLIC_BASE_URL`, `OPENGENI_BETTER_AUTH_SECRET`, trusted origins,
  allowed hosts, and cookie domain consistently;
- preserve `Origin`, `Sec-Fetch-Site`, cookies, and the
  `x-opengeni-api-contract`, `x-opengeni-session-csrf`, and
  `x-opengeni-actor-epoch` headers through the reverse proxy;
- run every API replica with the same session-set mode and signing secret;
- use the owner migration connection only for migration 0362 and keep the API on
  the restricted, FORCE-RLS-checked runtime role;
- retain popup capability and first-party same-origin navigation in browser/CSP
  policy; and
- expose neither the Better Auth database nor session-set tables to browser,
  worker, agent, SDK consumer, or operator dashboards.

The canonical verification lanes are the real PostgreSQL migration suite, real
Better Auth/Hono integration, API/SSE tests, and the `accounts` browser-acceptance
CI lane. That lane must fail instead of skip when PostgreSQL, a migrated
restricted role, production web build, or Chromium/Firefox/WebKit is absent.

Canonical source: `packages/db/drizzle/0362_managed_auth_session_sets.sql`,
`packages/core/src/managed-auth-session-sets.ts`,
`packages/core/src/managed-session.ts`,
`apps/api/src/routes/managed-auth-session-sets.ts`,
`apps/api/src/auth/managed-auth-session-adapter.ts`,
`packages/contracts/src/managed-auth-session-sets.ts`,
`packages/sdk/src/accounts.ts`, and `packages/react/src/accounts.tsx`.
