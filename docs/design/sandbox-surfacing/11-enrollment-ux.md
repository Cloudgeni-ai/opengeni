# 11 — Self-hosted enrollment UX: one-command + click-Grant + headless token

**Status:** design frozen; implementation in progress on `claude/enroll-ux-easy-path`.

## Why

Enrolling a self-hosted machine is not "super easy" today. Three concrete breaks (all
verified against `main`):

1. **The user must hand-type the workspace UUID.** The web Machines page has the
   workspace id in scope but discards it (`apps/web/src/routes/machines.tsx:30` `void
   workspaceId`); the copied one-liner is a bare `curl .../install.sh | sh` that carries
   nothing. On the machine the agent then bails *"enrollment requires a workspace id"*
   (`agent/.../main.rs:249`).
2. **The approve page is a dead link.** The agent prints `<origin>/device` to approve, but
   there is no `/device` route in `apps/web/src/App.tsx` — it 404s. The `EnrollmentConsent`
   component that renders the "Grant access?" screen is exported from `@opengeni/react` but
   mounted nowhere.
3. **No headless path.** `OPENGENI_ENROLL_TOKEN` / `--non-interactive` exist on the agent
   CLI and in `install.sh`, but `enroll_with_token` (`main.rs:315-331`) is a deliberate
   stub — there is no control-plane token-exchange endpoint.

This doc specifies the fix in three coherent parts. **A1+B ship without an agent rebuild;
A2 requires the per-SHA agent binary to be re-baked into the API image** (see §Build).

---

## A1 — carry the workspace (and control-plane origin) into the one-liner

Non-secret. Keeps the human device-approve step.

**Web** (`apps/web`):
- `src/lib/deployment.ts`: `installOneLiner(baseUrl, opts?: { workspaceId?: string; enrollToken?: string })`.
  - Interactive (workspaceId): `` curl -fsSL ${origin}/install.sh | OPENGENI_API_URL=${origin} OPENGENI_WORKSPACE_ID=${ws} sh ``
  - Headless (enrollToken, see A2): `` curl -fsSL ${origin}/install.sh | OPENGENI_API_URL=${origin} OPENGENI_ENROLL_TOKEN=${tok} sh ``
  - `origin` is `originOf(baseUrl)` exactly as today. Always include `OPENGENI_API_URL=${origin}`
    so the agent targets *this* deployment, not the `api.opengeni.ai` default (latent bug).
  - Keep `deviceVerificationUri` returning `${origin}/device` (page resolves workspace from the code, see B — no workspace in the URL needed).
- `src/routes/machines.tsx`: drop `void workspaceId` (line 30); call
  `installOneLiner(origin, { workspaceId })` at line 35. The default rendered command is the
  interactive one. (Headless token UI is A2.)

**install.sh** (`agent/install/install.sh`) — ships immediately (served verbatim):
- Document `OPENGENI_WORKSPACE_ID` and `OPENGENI_API_URL` in the env block (lines 22-53).
- The agent already reads both via clap `env=` (`cli.rs:106`, `cli.rs:31`) and inherits the
  script's environment, so the interactive `exec "$_bin" run` (line 334) and the printed
  `enroll` guidance (line 323) already pick them up. Make the printed guidance reflect this
  (e.g. note that `OPENGENI_WORKSPACE_ID`/`OPENGENI_API_URL` are honored). No behavioral
  change is required beyond docs + forwarding `--api-url`/`--workspace-id` explicitly on the
  non-interactive enroll call (line 315) for robustness.

**Agent:** no functional change required for A1 (clap already supports it). Do NOT rebuild for A1.

---

## B — wire the `/device` approve page (mounts existing `EnrollmentConsent`)

Pure web + API. No agent change. Baseline UX works even if the agent prints the bare
`/device` URL (user pastes the code); the `?user_code=` form pre-fills it.

### B.1 New API read endpoint — pending lookup by user_code

`EnrollmentConsent` is presentational; it needs `{ userCode, machine }`. There is no read
endpoint today (only `device/approve` consumes the code). Add a lookup that resolves the
workspace **from the (globally-unique-among-pending) user_code**, authorizes, and returns
machine details without consuming:

- **`POST /v1/enrollments/device/lookup`** — **authenticated** (session cookie), **no
  workspace in the path**. Body `{ userCode }`.
- Behavior: `getPendingDeviceEnrollmentRequestByUserCode` is per-workspace, but `user_code`
  is globally unique among `status='pending'` (partial unique index
  `db/.../schema.ts:692`). Resolve the pending request by code → get its `workspaceId` →
  `requireAccessGrant(c, deps, workspaceId, "enrollments:read")`. If the grant check fails
  or no live pending row → **404** (do not reveal cross-workspace existence). Else return:
  - `{ workspaceId, userCode, machine: { machineName, os, arch, canOfferDisplay, requestsScreenControl }, expiresAt }`.
- Rate-limit with a new `lookupLimiter` (reuse the `TokenBucket` pattern,
  `enrollments.ts:202`). Gate behind `sandboxSelfhostedEnabled` like the others.
- New contracts: `DeviceEnrollmentLookupRequest` / `DeviceEnrollmentLookupResponse`
  (`packages/contracts/src/index.ts`, beside the existing device-flow contracts ~2813-2939).

### B.2 Approve / deny

- Approve already exists: `POST /v1/workspaces/:workspaceId/enrollments/device/approve`
  (`enrollments.ts:119`). Reuse as-is.
- Add **`POST /v1/workspaces/:workspaceId/enrollments/device/deny`** mirroring approve
  (auth `enrollments:manage`, body `{ userCode }`), calling the existing
  `denyDeviceEnrollmentRequest` DAO (`db/.../index.ts:4517`) — the DAO exists but has no
  route. Response `{ denied: boolean }`.

### B.3 SDK methods (`packages/sdk/src/client.ts`, beside `listMachines` ~205)

- `lookupDeviceEnrollment(userCode): Promise<DeviceEnrollmentLookupResponse>` →
  `requestJson("POST", "/v1/enrollments/device/lookup", { userCode })`.
- `approveDeviceEnrollment(workspaceId, { userCode, allowScreenControl })` →
  `POST /v1/workspaces/${ws}/enrollments/device/approve`.
- `denyDeviceEnrollment(workspaceId, { userCode })` →
  `POST /v1/workspaces/${ws}/enrollments/device/deny`.

### B.4 Web route (`apps/web`)

- New `apps/web/src/routes/device.tsx` mounting `EnrollmentConsent` from `@opengeni/react`.
- `apps/web/src/App.tsx`: a **top-level** `createRoute({ getParentRoute: () => rootRoute,
  path: "device", validateSearch })` (model on `billingReturnRoute` ~54-62), added to
  `rootRoute.addChildren([...])` (~153), with a `Device()` wrapper. `validateSearch` parses
  `?user_code` (from `verificationUriComplete`).
- Page flow (via `useAppContext()` — `client`, `authSession`, `accessContext`):
  1. If `authSession` is null → prompt sign-in (return to `/device?user_code=…`).
  2. Read `user_code` from search; if absent, render a small input for it.
  3. `client.lookupDeviceEnrollment(userCode)` → `{ workspaceId, machine }`. On 404 →
     `phase="error"` ("This code isn't valid or has expired").
  4. Render `<EnrollmentConsent userCode machine phase onApprove onDeny />`.
     - `onApprove(allowScreenControl)` → `client.approveDeviceEnrollment(workspaceId,
       { userCode, allowScreenControl })`; set `phase` review→approving→approved/error.
     - `onDeny()` → `client.denyDeviceEnrollment(workspaceId, { userCode })`; `phase="denied"`.

No change to the `@opengeni/react` package — `EnrollmentConsent` props already suffice.

---

## A2 — non-interactive enroll-token exchange (headless / fleet, zero clicks)

Secret, short-TTL, multi-use-within-TTL, workspace-scoped. The token **is** the grant (no
human approve). Stateless-signed — **no DB table, no migration**.

### A2.1 Token format & signing (`packages/contracts/src/index.ts`, beside `signEnrollmentBearer` ~636)

- Reuse the **existing** `OPENGENI_ENROLLMENT_SIGNING_SECRET`
  (`packages/config/.../index.ts:941`) — already provisioned on staging (the device bearer
  is signed with it). **No new deploy secret.**
- `signEnrollToken(secret, { typ: "enroll", workspaceId, accountId, allowScreenControl, iat,
  exp })` → opaque token with prefix **`oget_`**. `verifyEnrollToken(secret, token)` →
  validates prefix + HMAC + `typ === "enroll"` + `exp`. **Domain separation:** the `typ`
  claim + `oget_` prefix make an enroll token unusable as an `oge_` bearer and vice-versa,
  even though the signing secret is shared. Mirror the bearer's encoding style.
- TTL: `ENROLL_TOKEN_TTL_SECONDS` default **3600** (1h). Long enough to script a fleet
  rollout, short enough to bound exposure.

### A2.2 Mint endpoint — authenticated

- **`POST /v1/workspaces/:workspaceId/enrollments/token`** — auth `enrollments:manage`
  (`requireAccessGrant`, mirror approve). Body `{ allowScreenControl?: boolean = false }`.
- `accountId` from the grant. `signEnrollToken(...)` with `exp = now + TTL`. If no signing
  secret → 503/"disabled" (mirror poll's `disabled` path, `enrollment.ts:253`).
- Response `{ token, expiresAt, expiresInSeconds }`. The web UI shows it **once** with a
  clear "secret — copy now, won't be shown again" warning.

### A2.3 Exchange endpoint — unauthenticated (the token is the auth)

- **`POST /v1/enrollments/token/exchange`** — unauthenticated, rate-limited
  (`exchangeLimiter`, reuse `TokenBucket`), gated behind `sandboxSelfhostedEnabled`.
- Body (same identity fields the agent sends to `device/start`): `{ token, publicKey, os,
  arch, machineName?, exposure?, canOfferDisplay?, requestsScreenControl? }`.
- Behavior: `verifyEnrollToken` → on failure 401/`disabled`. Extract
  `workspaceId/accountId/allowScreenControl`. Then perform the **same finalize as approve**:
  upsert the `enrollments` row (idempotent on `(workspace_id, pubkey)`, via
  `createEnrollment` `db/.../index.ts:4153`) and ensure a `kind='selfhosted'` sandbox row,
  `consentedWholeMachine=true`, `consentedScreenControl=allowScreenControl`. Then
  `buildEnrollmentCredentials(...)` (`enrollment.ts:293`) and return
  `{ credentials: EnrollmentCredentialsResponse }` — **identical credential shape** to the
  `poll` authorized branch (so the agent's existing `wire::Credentials` parsing is reused).
- **Reuse, don't fork:** factor the "upsert enrollment + ensure sandbox + build
  credentials" core so both `approve` and `exchange` call it. The existing approve path and
  its tests **must still pass** unchanged.

### A2.4 Agent (Rust — requires rebuild)

- `agent/.../enrollment.rs`: add `EXCHANGE_PATH = "/v1/enrollments/token/exchange"` and an
  `exchange_token(req, identity, token)` that POSTs `{ token, publicKey, os, arch,
  machineName?, ... }` and parses the **existing** `wire::Credentials` from
  `{ credentials }`. Reuse `Credentials::into_proto`.
- `agent/.../main.rs:315-331`: replace the `enroll_with_token` stub with a call to
  `exchange_token`, then `config::save_credentials(&stored)` (same persistence as the device
  path, `main.rs:301`). Dispatch already routes here when `--non-interactive`/`--token`/
  `OPENGENI_ENROLL_TOKEN` is set (`main.rs:239-244`).
- Optional nicety (include since we're rebuilding anyway): have the device-flow prompt print
  `verificationUriComplete` (pre-filled `?user_code=`) rather than the bare URL, improving B.

### A2.5 Web headless UI (`apps/web/src/routes/machines.tsx`)

- Add a "Headless / fleet enroll token" action that calls `client.mintEnrollToken(workspaceId,
  { allowScreenControl })` (new SDK method →
  `POST /v1/workspaces/${ws}/enrollments/token`), then renders
  `installOneLiner(origin, { enrollToken })` with the copy-once secret warning + the expiry.

### A2.6 install.sh

- Already invokes `enroll --token "$OPENGENI_ENROLL_TOKEN" --non-interactive` (line 315) and
  documents `OPENGENI_ENROLL_TOKEN` (line 38). Only add `OPENGENI_API_URL` forwarding (A1).

---

## Security notes (owner analysis)

- The enroll token grants enrollment of **one machine identity (the agent's pubkey) into one
  workspace** until expiry. Holding it ⇒ can enroll a rogue machine into that workspace.
  This is the intended fleet semantic and is the same trust class as the existing `oge_`
  bearer (also a stateless bearer secret). Bounded by: short TTL (1h), workspace scope (not
  account-wide), post-hoc revocation (revoke endpoint, `enrollments.ts:174`), and copy-once
  UI with an explicit secret warning. Acceptable for v1 self-hosted.
- Domain separation (`typ` + `oget_` prefix) prevents cross-use of enroll token ↔ bearer.
- `device/lookup` returns nothing unless the caller holds an `enrollments:read` grant in the
  code's workspace → no cross-workspace disclosure; rate-limited against code brute force.
- The workspace id baked into the A1 one-liner is **not** a secret (it is already in URLs);
  only the A2 token is.

## Build / deploy

- **A1 + B**: web + API + `install.sh` only → ship on a normal deploy; verifiable on staging
  immediately, **no agent rebuild**.
- **A2**: agent-crate change → the new per-SHA `opengeni-agent` binary must be rebuilt,
  re-signed, and baked into the API image (`apps/api/src/routes/install.ts:161`) for the
  staging SHA before end-to-end A2 verification. Confirm the CI bake step ran for the
  deployed SHA, else the install pulls an older agent with the stub.

## Verification plan (staging)

1. A1: copy the one-liner from Machines → it carries `OPENGENI_API_URL` + `OPENGENI_WORKSPACE_ID`; run on the verify VM → agent device-enrolls with no UUID typing.
2. B: open the printed `/device?user_code=…` while signed in → consent screen renders machine
   details → Grant → agent proceeds; machine appears in the dock.
3. A2: mint a headless token in the UI → run the headless one-liner on a fresh box → agent
   enrolls with **zero** approve clicks; machine appears.
4. Regression: existing device-flow approve path + the 26-check V-matrix still green.
