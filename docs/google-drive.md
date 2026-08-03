# Google Drive connection and sync preview

OpenGeni can connect a Google account once, choose multiple Shared Drives or
folder boundaries, and configure recurring incremental sync from the Capabilities
page. This first slice is intentionally a connector preview:

- OAuth and refresh tokens are server-side only and encrypted in the existing
  connection vault.
- OpenGeni requests
  `https://www.googleapis.com/auth/drive.readonly` so it can resolve Shared
  Drive names and later read documents for ingestion.
- Selecting folders or Shared Drives stores their boundaries, future knowledge
  scope, sync cadence, and read policy on the connection.
- The saved schedule and policy do not yet create a knowledge source, download
  files, run a backfill, or update workspace memory. A reusable server-side
  inventory/export planner now defines the first execution boundary, but no API
  or worker dispatches it yet.

Google currently classifies `drive.readonly` as a restricted scope.
Keep the OAuth app in Testing with explicit test users for local development.
Production use requires Google's applicable verification and security review.

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
all share the connection's `(id, version)` compare-and-set fence. Duplicate
pause/resume/disconnect requests converge on the already-reached state, while a
stale conflicting action returns a retryable conflict instead of overwriting
newer credential or lifecycle truth.

Only bounded OAuth error codes are used to classify permanent refresh failures.
Google response descriptions, response bodies, tokens, and client secrets are
never written to connection metadata or `lastError`, and the browser renders
state-owned guidance rather than provider text.

## Sync configuration behavior

The browser starts at **My Drive**. Checkboxes connect the current location or
any visible subfolder; selecting a parent includes every nested folder. Multiple
locations can be connected in one setup. A Shared Drive or shared folder can be
added by pasting its full `https://drive.google.com/.../folders/...` URL or ID.

The intended first successful run recursively imports all existing supported
documents inside the selected boundary. Subsequent scheduled runs use a durable
cursor to process only new, changed, moved, or deleted documents since the last
successful run; they do not re-ingest every unchanged document each hour.

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
  checkpoint bound to the normalized Google permission, external tenant,
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

This planner does not fetch bytes, persist provider/source/object/version rows,
create Documents or chunks, run embeddings, dispatch a schedule, or expose a
public API/UI. Those remain later inventory/backfill slices. Durable change
cursors and event reconciliation are a separate incremental-sync boundary;
Drive ACL intersection, revocation, and citation reauthorization are a separate
authorization boundary.

The **Only me**, **This workspace**, and **Company** options record the intended
future knowledge scope. **Hourly**, **Daily**, and **On demand** record the
intended cadence, while **Allow**, **Ask**, and **Block** record the connector
read policy. The common MCP runtime can now enforce persisted connector-action
policies with durable approval and secret-free audit, but this Google Drive setup
slice does not yet publish its selections into that backend policy table.
They remain configuration only in this slice. Durable scheduler dispatch, source
rows, content fetching and indexing, cursor processing, ACL projection,
policy-UI wiring, and memory updates are not activated by the inventory planner.

Disconnecting revokes the OpenGeni connection locally. The confirmation dialog
states that this deliberately does not call Google's project-wide token
revocation endpoint, which can invalidate other grants for the same Google OAuth
project. Reconnect replaces the credential in place and refuses a different
Google account; disconnect first to switch accounts.
