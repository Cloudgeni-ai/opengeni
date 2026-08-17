# Google Drive connection and scheduled knowledge sync

OpenGeni can connect a Google account once, choose multiple Shared Drives or
folder boundaries, and explicitly enable scheduled synchronization from the
Capabilities page. Saving a selection alone is inert; enabling synchronization
materializes a scoped knowledge source and a shared Schedule action:

- OAuth and refresh tokens are server-side only and encrypted in the existing
  connection vault.
- OpenGeni requests
  `https://www.googleapis.com/auth/drive.readonly` so it can resolve Shared
  Drive names and later read documents for ingestion.
- Selecting folders or Shared Drives freezes their exact source boundary,
  organization/workspace/personal destination, initiating subject, owning
  connection identity, source configuration generation, and read policy.
- The separate **Enable synchronization** decision creates one provider-neutral
  `knowledge_source_sync` action per enabled boundary and starts an idempotent
  initial backfill. The action never creates an agent session, invokes a model,
  or records an agent-run charge.
- Shared **Schedules** becomes canonical for cadence and the user's per-source
  pause state after creation. A later connector save does not overwrite either.
- Source inventory, downloads/exports, canonical blobs, Documents, immutable
  source-object/document-version provenance, and document indexing run in a
  dedicated checkpointed Temporal workflow.
- The connector's read policy controls interactive connector actions only.
  Background sync is authorized solely by **Enable synchronization** and does
  not pause for per-run approval.
- Deleting a sync Schedule first disables that exact source selection and
tombstones its scoped source. Later saves keep it disabled until the same
initiating subject explicitly enables synchronization again.

The Capabilities platform can install multiple named Drive instances (for
example, Finance and Sales). Each instance is bound to one exact Personal or
workspace Connection and its own feature configuration; provider-domain
fallback and singleton credential reuse are not authority. The newer provider
preset may expose separately reviewed Drive read/write tools, while scheduled
knowledge ingestion remains an explicit source feature with its own destination
and enablement fences.

Google currently classifies `drive.readonly` as a restricted scope.
Keep the OAuth app in Testing with explicit test users for local development.
Production use requires Google's applicable verification and security review.

## Current source-selection surface

The shipped selector is OpenGeni's custom server-backed folder browser, not
Google Picker. The browser starts at My Drive, asks the API to list folders with
Shared Drive support enabled, and lets the user paste a folder or Shared Drive
URL/ID when it is not reachable from My Drive navigation. The server resolves
every selected boundary again before saving it; browser-supplied names, MIME
types, and Drive IDs are not accepted as authority by themselves.

The Connect and reconnect surface must stay explicit about the current product
contract:

- OpenGeni requests read-only access to browse folders and Shared Drives and to
  read supported files only after the user separately enables synchronization.
- Selection alone remains inert. It records boundaries, destination authority,
  cadence defaults, and interactive read policy without starting ingestion.
- OpenGeni cannot create, edit, or delete files in Drive. Outbound publishing is
  a separate capability and is not implied by this connector.
- Publication destination authority is frozen at turn acceptance: the exact
  output folder is copied into the accepted delegation, and a later
  connection-settings change fails the already-accepted turn's publication
  closed instead of silently redirecting it (pre-freeze turns keep the bounded
  legacy live resolution). Every publication - model or Codemode caller -
  registers a durable execute-once fence before any provider request; a
  failure before the first request settles `not_executed` (safe to retry),
  while a failure after it settles `uncertain` and the tool surfaces the
  unknown outcome so nobody blindly retries a POST that may have landed.
- OAuth tokens remain encrypted and server-side. They do not enter browser
  persistence, model context, agent sandboxes, source metadata, logs, or webhook
  payloads.
- The first enabled sync inventories existing supported files. Later scheduled
  runs drain the Google Drive Changes feed and periodically perform a bounded
  full repair that skips unchanged provider revisions. Workspace Events/Pub/Sub
  delivery remains a separate, default-off release follow-on.

## Launch OAuth scope decision

The current connector configures a continuously readable folder, My Drive, or
Shared Drive boundary. That product mode requires
`https://www.googleapis.com/auth/drive.readonly`:

- `drive.file` grants per-file access to files created by the app or explicitly
  opened/shared with it. It does not prove that OpenGeni can continuously
  discover every present or future descendant of a selected folder or Shared
  Drive, so it never satisfies the recursive-source-sync capability.
- `drive.metadata.readonly` can describe Drive items but cannot read document
  content. Legacy metadata-only connections must reconnect before source
  browsing/configuration because every saved boundary promises later recursive
  content synchronization.
- `drive.readonly` satisfies metadata discovery, content reads, and recursive
  source synchronization. A previously granted full `drive` scope is
  semantically sufficient but OpenGeni does not request that broader scope.
- A future narrow Google Picker mode may use `drive.file` only when its source
  contract is explicitly limited to the individually selected files. It must
  not be represented as a recursively synchronized folder.

OAuth start continues to use Google's incremental-authorization flag. A future
Drive publishing feature may request `drive.file` as a separate write capability
without replacing the read-only source grant. The callback and every active
source-browser admission evaluate the exact returned/stored scope set through
one deterministic capability decision. Unknown, partial, write-only, or malformed
grants fail before Google identity lookup, credential persistence, or
source-provider reads.

## Local setup

1. In Google Cloud, enable the Google Drive API.
2. Configure the OAuth consent screen, add
   `https://www.googleapis.com/auth/drive.readonly`, and add your
   Google account as a test user.
3. Create an OAuth client of type **Web application**.
4. Add this exact authorized redirect URI:

   ```text
   http://127.0.0.1:8000/v1/integrations/google-drive/callback
   ```

5. Add the following to `.env`:

   ```bash
   OPENGENI_INTEGRATIONS_ENABLED=true
   OPENGENI_PUBLIC_BASE_URL=http://127.0.0.1:8000
   OPENGENI_WEB_BASE_URL=http://127.0.0.1:3000
   OPENGENI_INTEGRATIONS_STATE_SECRET=replace-with-random-state-secret
   OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY=replace-with-base64-32-byte-key
   OPENGENI_GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret
   ```

   Generate the encryption key with `openssl rand -base64 32` and the state
   secret with `openssl rand -hex 32`.

6. Run `bun run dev`, open `http://127.0.0.1:3000`, go to **Capabilities**, and
   choose **Connect Google Drive**.

The dev stack can select another API or web port if the defaults are occupied.
If that happens, update both base URLs and the Google authorized redirect URI
to the exact ports printed by the dev stack.

## Provider-free release-readiness receipt

Run the source-controlled readiness command from the exact candidate checkout:

```bash
bun run deployment:google-drive-readiness
```

The command parses the ordinary OpenGeni runtime configuration and emits one
secret-safe JSON receipt with schema
`opengeni.google-drive-release-readiness.v1`. It verifies integration
enablement, the presence of the OAuth client pair, signed-state and credential
encryption secrets, the public callback origin, structured logs, and metrics.
It prints only the derived callback URL and numeric budgets; it never prints
secret values, OAuth tokens, provider response bodies, or request URLs. The
receipt always states `providerCallsPerformed: false` and makes no Google API,
deployment, database, or Kubernetes call.

Exit status `0` means the local configuration checks passed, `2` means one or
more readiness checks blocked, and `3` means the runtime configuration was
invalid. A successful receipt is reusable source evidence only. It does not
prove that every declared Drive source-security dependency is merged, authorize
a non-production real-provider test, authorize a deployment, or establish
Google verification, security-assessment, legal, or production acceptance.

The configurable source budgets below are validated at process startup and
persisted into every newly created or authorizedly updated Drive sync Schedule.
Existing schedules retain their previously persisted limits until an authorized
source save updates them.

| Environment variable | Default | Validated purpose |
| --- | ---: | --- |
| `OPENGENI_GOOGLE_DRIVE_SYNC_MAX_ITEMS` | `500` | Maximum items examined by one source run. |
| `OPENGENI_GOOGLE_DRIVE_SYNC_MAX_BYTES` | `500000000` | Maximum total content bytes accepted by one run. |
| `OPENGENI_GOOGLE_DRIVE_SYNC_MAX_FILE_BYTES` | `100000000` | Maximum bytes for one file; must not exceed the total-byte limit. |
| `OPENGENI_GOOGLE_DRIVE_SYNC_MAX_PROVIDER_REQUESTS` | `1000` | Maximum logical provider operations charged to one run. |
| `OPENGENI_GOOGLE_DRIVE_SYNC_MAX_ELAPSED_SECONDS` | `300` | Maximum cumulative source-run elapsed time. |
| `OPENGENI_GOOGLE_DRIVE_SYNC_MAX_FAILURE_DETAILS` | `25` | Maximum bounded per-item failure details retained in a result. |
| `OPENGENI_GOOGLE_DRIVE_PROVIDER_REQUEST_TIMEOUT_MS` | `30000` | Per-attempt timeout for a Drive HTTP request. |
| `OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_ATTEMPTS` | `3` | Maximum physical attempts for one retryable operation, including the first attempt. |
| `OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_INITIAL_DELAY_MS` | `250` | Initial exponential retry delay. |
| `OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_MAX_DELAY_MS` | `5000` | Maximum delay for one retry; must be at least the initial delay. |
| `OPENGENI_GOOGLE_DRIVE_PROVIDER_RETRY_BUDGET_MS` | `15000` | Maximum cumulative retry delay for one logical operation; must be at least the initial delay. |

Bounded retries cover start-page-token, changes-page, metadata, folder-list,
download, and export requests. Only transport failures, HTTP `429`, and HTTP
`5xx` responses are retried; permanent provider responses retain the existing
credential, permission, cursor, and reconnect classifications. Retry delay
honors a bounded `Retry-After` value and otherwise uses capped exponential
backoff. Exhausting the local policy returns control to the durable sync
workflow. Physical retry attempts have separate telemetry and do not consume
additional units from the durable source run's logical provider-request budget.

Use `deploy/helm/opengeni/values.google-drive-readiness.example.yaml` as a
non-secret values overlay during review. Its referenced runtime Secret must
provide `OPENGENI_INTEGRATIONS_STATE_SECRET`,
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, `OPENGENI_GOOGLE_DRIVE_CLIENT_ID`, and
`OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET`; never put their values in Helm values or
readiness evidence.

### Sync-health evidence and response

The canonical `Google Drive sync` Grafana dashboard reports run outcomes,
failure ratio, reconnect-required events, p95 terminal activity-batch duration, provider attempts and
retries, explicit limit hits, and bounded terminal failure reasons. The Helm
chart adds exact namespace/release/environment/provider-scoped alerts for a
sustained failure ratio, reconnect-required events, and explicit limit hits.
Structured terminal logs contain bounded reason and numeric counters only; they
must not contain provider URLs, headers, bodies, tokens, or secrets.

Operators should respond to reconnect-required alerts through the normal
user-owned connection lifecycle, not by copying credentials. Investigate
failure reasons and retry telemetry before increasing limits or retry budgets.
A limit-hit alert is evidence that the configured safety boundary worked, not
automatic authority to widen it.

Release progression remains explicitly staged:

1. Produce source-only tests, type checks, static chart/dashboard evidence, and
   the provider-free readiness receipt from the exact candidate.
2. Keep release acceptance blocked until every declared Drive source-security
   dependency is merged and reconciled against the candidate.
3. Run any real-provider acceptance only in a separately owned non-production
   Google project after an authorized human records explicit approval.
4. Require a separate explicit human approval for deployment or production
   live-provider acceptance. No source merge or non-production result supplies
   that authority.

## Connection lifecycle and recovery

The Capabilities card projects one explicit, durable state for the current
subject-owned Google Drive connection:

- **Connected** permits source browsing and configuration.
- **Paused** is a local reversible stop. OpenGeni does not browse or use saved
  Drive locations until the same connection is resumed.
- **Token revoked** means Google rejected the refresh grant. Reconnect with the
  same Google account to preserve the connection and configured locations.
- **App removed** is terminal for the current deployment configuration. An
  administrator must restore the Google OAuth app before reconnect can work.
- **Reconnect required** covers other permanent credential failures that do not
  prove a narrower cause.
- **Re-consent required** means the grant no longer proves the selected-source
  read capability, including known Google permission failures and legacy
  metadata-only grants.
- **Disconnected** keeps the row and its configuration as inactive audit truth.
  A new account may be connected only after this local disconnect.

Pause, resume, source changes, refresh transitions, disconnect, and reconnect
all share the connection's `(id, version)` compare-and-set fence. A disconnect
also carries a stable idempotency key bound durably to the expected and result
versions. Exact retries converge only while that result generation remains
current; reconnect or any later transition permanently fences a delayed old
DELETE. A stale conflicting action returns a retryable conflict instead of
overwriting newer credential or lifecycle truth.

Only bounded OAuth error codes are used to classify permanent refresh failures.
Google response descriptions, response bodies, tokens, and client secrets are
never written to connection metadata or `lastError`, and the browser renders
state-owned guidance rather than provider text.

## Sync configuration behavior

The browser starts at **My Drive**. Checkboxes connect the current location or
any visible subfolder; selecting a parent includes every nested folder. Multiple
locations can be connected in one setup. A Shared Drive or shared folder can be
added by pasting its full `https://drive.google.com/.../folders/...` URL or ID.

The first successful run captures a Google Drive Changes start page token before
recursively inventorying all existing supported documents inside an enabled
boundary. For My Drive, OpenGeni resolves Google's `root` alias to the actual
root folder ID before using parent ancestry to classify later changes; an
unresolved or non-folder root fails closed instead of advancing the cursor.
After that complete inventory settles, normal scheduled runs drain the Changes
feed page by page and durably advance the provider cursor only with the
successful source lease settlement. Shared Drive token, change, metadata, and
inventory requests carry the exact drive identity plus Google's all-drives
support parameters. OpenGeni does not overload the scoped-knowledge
`sync_cursor` column with provider cursor or execution checkpoint state.

Changes checkpoints persist cumulative examined-change, provider-request, and
elapsed-time budgets across every continuation. Every returned change counts,
including removal-only pages, and ancestry metadata requests share the same
provider-request budget. Page requests use only the remaining item allowance;
hard item, request, or total-time exhaustion fails as `resource_limit` rather
than creating another continuation. Bounded invocation-time pauses may resume,
but retain their consumed totals. Repeated page tokens and oversized provider
pages fail as invalid provider payloads. A delta that requires a full repair
carries the same consumed budget into the full inventory checkpoint.

That delta-to-full checkpoint also carries a bounded per-object provider
revision floor for every accepted delta object and every accepted full-page
object. Full inventory entries with an equal or older canonical decimal Drive
revision are ignored, so they cannot replace the newer delta observation or
current version before the terminal Changes token settles. Exact repeats of a
fallback revision identity are likewise ignored; differing fallback identities,
including a missing identity on only one side, are not ordered by guesswork and
fail as invalid provider payloads without adopting the terminal token.
Full-reconciliation checkpoints use version 3 for this contract. Older
version-2 full checkpoints replay the still-unsettled Changes window before
creating a replacement version-3 full checkpoint, while version-2 Changes
checkpoints remain replay-compatible. The complete encoded execution checkpoint
remains capped at the database's 2 MiB bound.

Changes that cannot be represented safely as a bounded object update trigger a
full repair instead of guessing. This includes known removals, trashing,
reparenting or moves outside the configured boundary, unresolved ancestry, and
folder topology changes. A later move/removal in the same drained window also
removes any earlier pending import for that object before repair. A rejected or
invalid Changes cursor similarly captures a fresh start token and completes a
full repair before adopting that token; it never skips directly to the new
cursor. Google documents start page tokens as non-expiring, so renewal is
driven by explicit invalidation rather than a guessed TTL. A bounded daily full
reconciliation remains an independent safety repair for missed provider history
even when no invalid-cursor response is observed.

Each repair scan has its own durable scan generation. Every object observed
across checkpointed pages is stamped into that generation; only a provider
response that explicitly declares the scan complete may tombstone active
objects absent from the complete generation. Partial, failed, paused, or
reconnect-required scans never infer deletion, and a failed run clears its
execution checkpoint before a later repair starts a new generation.
The first accepted observation for one object within a scan generation becomes
the durable floor. Canonical decimal Drive revisions may advance that floor
monotonically, but an older/equal/conflicting replay cannot overwrite its
provider revision or metadata hash. Acceptance is bound to the exact sync lease,
initiating subject, scan generation, and execution-checkpoint generation before
item processing begins. Version/metadata writes lock and revalidate the exact
accepted floor, and checkpoint or terminal cursor settlement atomically
revalidates the same floor and checkpoint generation.

If a process dies after accepting and fully processing version 8 but before its
returned full-page checkpoint is saved, replaying the same durable pre-page
checkpoint against stale version 7 reads the version-8 observation floor. The
stale entry is suppressed only when the current immutable version, metadata,
source/object lifecycle generations, ACL generation, and indexed obligation
prove version 8 was fully materialized; otherwise the run fails closed without
saving the stale checkpoint or adopting the terminal Changes token. A paused
replay that is safe to continue rewrites its returned checkpoint to the durable
version-8 floor. A newer scan generation may replace the observation normally.

`manual`, `hourly`, and `daily` map to an on-demand Schedule, a one-hour
interval, and a daily 00:00 UTC calendar respectively. The Schedules UI exposes
pause/resume, run-now, cadence editing, deletion, source/scope identity,
reconnect state, and per-run imported/unchanged/skipped/failed counts.
Schedule deletion is stronger than pause: it durably clears the connector's
sync-enable decision before removing the Temporal schedule and database row.
An explicit connector re-enable creates a new Schedule against the restored
source lifecycle generation.

Canonical blob storage is content-addressed, but Document identity is not.
Each provider source object/version receives its own immutable Document identity
even when another object has identical bytes. Advancing an object's version
revokes agent access to the previous Document, removes its indexed chunks, and
invalidates delayed index or ACL completions before the replacement can become
eligible.

## Bounded inventory and export planning

`@opengeni/documents/google-drive` owns the provider-neutral execution plan for
the first backfill slice:

- The selected destination is frozen to exactly one organization, current
  workspace, or initiating-user personal authority. Personal Drive knowledge
  keeps the current workspace anchor rather than silently widening across
  workspaces.
- Google permission, source-boundary, and file IDs remain stable provenance
  identities. Folder names, locations, and deep links are metadata rather than
  authority.
- Inventory is paginated and breadth-first, with a versioned serializable
  execution checkpoint bound to the normalized Google permission, external tenant,
  source drive/boundary, and destination authority identities. Legacy,
  unversioned, or incompatible checkpoints fail closed before buffered items or
  provider access. Explicit cumulative item, known-byte, Drive-request/cost,
  folder, per-file, and per-invocation time limits still apply.
- A fetched page is buffered in the checkpoint before its items are consumed,
  so a crash or bounded pause resumes without refetching or skipping the
  remainder of that page.
- Google Docs, Sheets, Slides, and Drawings all use PDF as one deterministic,
  dependency-free ingestible export format for the parser shipped in OpenGeni's
  workload images. Ordinary PDF and text-like files use authenticated download
  planning. Office and image conversion formats stay unsupported until their
  system converters are part of the workload contract. Export and unknown
  download sizes must be bounded again while streaming bytes.
- Unsupported native types, shortcuts, ordinary file types, oversized files,
  duplicate/looped folders, and folder-limit overflows are isolated as skipped
  items so healthy siblings continue.
- An incomplete Drive search or failed provider page does not consume the page
  or advance its checkpoint. The caller receives a typed stop reason and may
  retry the same page.

The worker uses a provider-neutral driver port for inventory, content transfer,
and opaque citation locators. It fetches bytes within the planner's limits,
stores content by SHA-256, converges repeated objects and versions, and creates
Documents in the frozen destination collection/default collection. Imported
Documents are deliberately `agentAccess=false`: each immutable version creates
a durable index obligation before indexing, and a later generation-fenced ACL
evidence operation is the only seam that may make the Document agent-readable.
The worker now reads every bounded Drive permissions page, hashes normalized
user/domain/permission principals before persistence, and records append-only,
freshness-bounded evidence against the exact source, object, immutable version,
file, Document, connection version, and index obligation. Unsupported group
membership remains fail-closed; owner identity, user, domain, and `anyone`
permissions are evaluated without storing plaintext ACL principals.

Every Knowledge read and every file-byte path reauthorizes the immutable
initiating subject at query/use time through migration 0243. The subject must
still have an active subject-owned read-only Google connection with a recursive
Drive read scope, and the source, object, current version, sync generation,
index obligation, connection lifecycle, provider revision, ACL evidence, and
evidence expiry must all remain current. Authorization is an all-protectors
intersection over every Google Drive object that has ever mapped to the exact
file bytes: an ordinary upload or a second allowed Drive object cannot mask one
denied, stale, or revoked Drive mapping. ACL refresh first clears the active
evidence pointer and Document agent access, so provider I/O never extends stale
readability. Search filters before ranking and rechecks selected rows; direct
get/browse, session resources, model-history images, sandbox mounts, signed
downloads, and image-generation file references recheck immediately before
returning metadata or bytes.

Authorized Knowledge records may include a bounded provider citation containing
only the external object/revision/version, Drive id, deep link, ACL revision,
and authorization observation/expiry/reauthorization timestamps. Connection
UUIDs and principal identities are never projected. Citation construction calls
the same live file-authorization predicate and returns no citation when any
protector fails.

Provider revision is observation metadata, not the immutable OpenGeni version
identity. A revision or metadata/ACL change is recorded even when the bytes,
Document, and file are unchanged, so the next repair does not repeatedly
download the same provider observation. Automatic Temporal retries also repair
both persistence seams: a current immutable version without an index obligation
gets one, and a pending obligation is re-indexed or settled before the item is
accepted as unchanged.

Durable wake receipts retain `scheduled`, `manual`, `initial`, `retry`,
`repair`, and future `provider_event` provenance even when overlapping fires
coalesce. Source configuration and lifecycle generations fence wake admission,
checkpointing, indexing obligations, ACL activation, and settlement. A stable
per-source workflow ID plus a Postgres lease and one-item execution buffer
enforce overlap and replay idempotency across worker restarts. Terminal runs
emit separate knowledge-sync usage events plus low-cardinality run/item/byte
metrics; they do not emit `agent_run.created`.

A successful source run advances the live source sync generation, and lease
settlement advances scheduler state to that exact output generation. Index and
ACL completions may settle against that live-or-newer scheduler generation only
while every source lifecycle/configuration, object/version, ACL, obligation, and
Document authority fence still matches. A retry that finds the deterministic
source run already complete settles that durable result without invoking the
provider again.

Connection pause is layered independently from the user's per-source Schedule
pause. Pausing or disconnecting a Drive connection suspends effective Temporal
delivery without rewriting the source's Schedule status; resume removes only
the connection-owned pause reason. Pause, disconnect, token revocation, app
removal, re-consent/reconnect requirements, and permission loss also advance a
deny ACL generation, invalidate outstanding index obligations, revoke Document
agent access, and delete materialized chunks. Resume or reconnect never restores
the old retrieval eligibility: a newly observed immutable version, successful
index obligation, and fresh generation-fenced ACL evidence are required.

As of August 10, 2026, Google Drive support in Workspace Events remains a
Developer Preview. `OPENGENI_GOOGLE_DRIVE_WORKSPACE_EVENTS_ENABLED` is therefore
default-off and exposes only an internal, deterministic `provider_event` wake
seam. Event payloads never mutate source truth or advance provider cursors; the
authoritative Changes drain and periodic full repair still do that work.
Workspace Events subscription/Pub/Sub provisioning and live provider acceptance
remain release work, as does Drive ACL/citation reauthorization.

The **Only me**, **This workspace**, and **Company** options are immutable
knowledge authority, not presentation labels. **Hourly**, **Daily**, and **On
demand** seed the newly created shared Schedule; later edits happen there.
**Allow**, **Ask**, and **Block** remain
the connector read-policy configuration used by the common connector-action
boundary. Workspace Events subscription provisioning, provider ACL projection,
policy-UI wiring, and memory updates are not activated by the inventory planner.

Disconnecting revokes the OpenGeni connection locally. The confirmation dialog
states that this deliberately does not call Google's project-wide token
revocation endpoint, which can invalidate other grants for the same Google OAuth
project. Reconnect replaces the credential in place and refuses a different
Google account; disconnect first to switch accounts.

## Restricted-scope external verification package

This section is the source-controlled, non-secret package for Google OAuth
verification and the applicable restricted-scope security assessment. It
describes shipped behavior and the evidence an authorized human/operator must
assemble. It does not authorize a Google submission, create production
credentials, approve legal language, deploy OpenGeni, or prove production
acceptance.

### Shipped product and security facts

Use these facts consistently in the OAuth consent screen, verification form,
demo video, privacy policy, user help, and security-assessment evidence:

1. OpenGeni requests only
   `https://www.googleapis.com/auth/drive.readonly` for this connector. The
   authorization request does not request full `drive` or a write scope.
2. The product uses a custom server-backed folder/Shared Drive browser. A user
   chooses one or more source boundaries and one immutable
   organization/workspace/initiating-user personal destination authority.
3. Saving a selection is inert. Content access begins only after the separate
   **Enable synchronization** decision, and the user can manage cadence and
   source pause state through Schedules.
4. The first sync inventories existing supported files. Later runs drain the
   Google Drive Changes feed and use bounded full repairs plus provider
   revisions to avoid unchanged downloads. Workspace Events/Pub/Sub delivery is
   not currently shipped.
5. OpenGeni reads supported file metadata and content within enabled selected
   boundaries. It does not create, edit, rename, move, share, or delete Google
   Drive files.
6. Signed OAuth state is short-lived and single-use, binds account, workspace,
   initiating subject, exact return path, and reconnect generation, and carries
   an encrypted PKCE verifier. The callback revalidates the initiating grant
   before and after provider identity lookup.
7. OAuth access/refresh tokens, the client secret, and PKCE verifier stay
   encrypted on the server. Browser projections expose connection metadata but
   not credentials.
8. After token resolution or refresh, both the browser and scheduled-sync worker
   reload the exact persisted connection generation and revalidate recursive
   read scope before the first Drive provider request. A refreshed scope
   downgrade therefore fails closed without exposing provider data.
9. Reconnect is bound to Google's immutable `permissionId`; a different account
   is rejected. Selected source identity and destination authority are frozen
   into the sync authority and revalidated before provider access and durable
   writes.
10. Pause, disconnect, revoked grants, app removal, re-consent requirements, and
   permission loss stop effective delivery and advance deny-side retrieval
   authority. Disconnect is local and intentionally does not call Google's
   project-wide token-revocation endpoint; users must remove CloudGeni access in
   their Google Account when they also want provider-side revocation.
11. Imported Drive Documents remain `agentAccess=false` until a fresh,
    generation-fenced ACL evidence operation authorizes retrieval. Knowledge
    ranking, exact reads, citations, and every file-byte consumer then recheck
    the current initiating subject through the same all-protectors authority.

Canonical implementation and proof:

- `apps/api/src/integrations/google-drive.ts`
- `packages/contracts/src/google-drive.ts`
- `packages/documents/src/google-drive.ts`
- `apps/worker/src/activities/knowledge-source-sync.ts`
- `apps/api/test/google-drive.test.ts`
- `apps/api/test/google-drive-oauth-isolation.test.ts`
- `packages/documents/test/google-drive.test.ts`
- `apps/web/src/lib/google-drive-connection.test.ts`

### Consent and in-product disclosure packet

The Capabilities surface carries the just-in-time product disclosure immediately
beside Connect/reconnect. The external consent configuration and demo must match
that shipped statement: read-only folder/Shared Drive browsing, explicit
sync-enable before content import, selected-boundary use, encrypted server-side
tokens, and no Drive file creation/edit/deletion.

Before submission, the Product/Privacy approver must approve and date all of the
following without widening the claims beyond shipped behavior:

- production app name, logo, homepage, support email, authorized domains, and
  exact HTTPS callback URL;
- scope justification for recursive selected-folder/Shared Drive synchronization;
- consent-screen description and the in-product just-in-time disclosure;
- demo-video narration showing Connect, consent, boundary selection, destination
  authority, explicit sync enablement, pause, local disconnect, and separate
  provider-side revocation guidance;
- launch gating that does not claim Workspace Events/Pub/Sub delivery, Drive
  writes, completed live-provider acceptance, or production deployment.

### Privacy, Limited Use, retention, and deletion packet

The public privacy policy and a Google Drive data-management/help page must be
stable-dated, linked from the OAuth consent configuration, and approved by the
named Product/Privacy owner. They must cover:

- data collected: Google account display/email/permission identity, selected
  folder/Shared Drive and file metadata, supported file content/exports,
  provider revisions, derived Documents/chunks/provenance, and encrypted OAuth
  credentials;
- exact user-facing purposes: selected-boundary synchronization, indexing, and
  authorized retrieval, with no claim that Drive data is used for unshipped
  features;
- sharing/transfers and subprocessors, including allowed human-access cases and
  the controls/consent governing them;
- an explicit, approved commitment to the Google API Services User Data Policy
  and its Limited Use requirements, including the approved rules for sale,
  advertising, generalized model training/improvement, and human access;
- separately approved retention periods and deletion/export service levels for
  OAuth credentials, source metadata, canonical blobs, Documents/chunks,
  provenance/audit records, caches, and backups. Source code must not invent
  these legal/product periods;
- user controls for source pause, Schedule pause/delete, local connection
  disconnect, workspace/account deletion, data export/deletion requests, and
  removing CloudGeni access from the user's Google Account;
- support contact, support owner, response target, escalation path, and the
  evidence users receive when deletion completes.

A generic privacy statement, a viewer-relative “Last updated” date, generic
infrastructure retention, or a broad platform-improvement purpose is not enough
to approve Google Workspace restricted-scope data use. The public policy must
state the Drive-specific approved contract explicitly.

### Restricted-scope security-assessment packet

The Security/CASA owner must assemble the evidence required by Google and the
approved assessor without copying production secrets into tickets, source,
model context, sandboxes, logs, or browser storage. The package should include:

- the selected-boundary data-flow and trust-boundary diagram from OAuth start
  through token exchange/refresh, provider reads, encrypted storage, sync,
  Documents/indexing, retrieval gating, pause/disconnect, and deletion;
- inventory of environments, systems, data stores, subprocessors, encryption,
  key ownership/rotation, least-privilege access, logging/audit, incident
  response, vulnerability management, backup/deletion behavior, and secure
  development/review controls;
- the OAuth isolation proof covering signed-state expiry/tampering/replay,
  exact redirect/reconnect shape, PKCE binding, grant revalidation, permission
  identity, token rotation, refreshed-scope downgrade before provider access,
  subject/workspace/account isolation, disconnect idempotency, and secret-sink
  absence;
- independent assessment/Letter of Validation owner, assessor, submission date,
  approval date, expiry/renewal date, findings, remediation receipts, and final
  Google disposition.

### Environment and credential separation

Development/testing and production must use separately owned Google Cloud
projects and OAuth clients, audiences, redirect origins, authorized domains,
test users, secrets, and approval records. Store only non-secret labels and
status receipts in the operator-owned acceptance tracker. Never record a client
secret, refresh/access token, authorization code, PKCE verifier, encryption key,
or production credential value in source control, an issue tracker, model
context, an agent sandbox, logs, or browser persistence.

### Human approval ledger and release gate

Record the following non-secret evidence in the operator-owned acceptance
tracker before any provider submission or production use:

| Gate | Required named owner and dated evidence |
| --- | --- |
| Product/Privacy | Approved consent, just-in-time disclosure, Drive-specific privacy/Limited Use, retention/deletion/export, and launch claims. |
| Google OAuth operator | Production project/client label, audience, domains, exact redirects, verification submission/status, and explicit testing/production separation. |
| Security/CASA | Assessment applicability decision, assessor, submission/findings/remediation, approval/Letter of Validation, and renewal date. |
| Support | Published help/data-management URL, support contact, response/escalation target, and deletion-completion workflow. |

Keep external acceptance blocked until every applicable row has a human owner,
date, evidence link, and Google/assessor status. A source merge supplies reusable
evidence only; it is not deployment, provider verification, security-assessment
acceptance, legal approval, or production readiness.

Official references to re-check at submission time:

- <https://developers.google.com/workspace/workspace-api-user-data-developer-policy>
- <https://developers.google.com/terms/api-services-user-data-policy>
- <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- <https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance>
- <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>
- <https://support.google.com/cloud/answer/13464321>
