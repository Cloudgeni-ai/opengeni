# Google Drive connection and sync preview

OpenGeni can connect a Google account once, choose an entire Shared Drive or
folder boundary, and configure recurring incremental sync from the Capabilities
page. This first slice is intentionally a connector preview:

- OAuth and refresh tokens are server-side only and encrypted in the existing
  connection vault.
- OpenGeni requests
  `https://www.googleapis.com/auth/drive.metadata.readonly`.
- The browser can see names, types, timestamps, folder structure, and links. It
  cannot download file content.
- Selecting a Shared Drive or folder stores its boundary, future knowledge
  scope, sync cadence, and read policy on the connection. Files in the browser
  are an included-content preview, not individually selected sources.
- The saved schedule and policy do not yet create a knowledge source, download
  files, run a backfill, or update workspace memory.

Google currently classifies `drive.metadata.readonly` as a restricted scope.
Keep the OAuth app in Testing with explicit test users for local development.
Production use requires Google's applicable verification and security review.

## Local setup

1. In Google Cloud, enable the Google Drive API.
2. Configure the OAuth consent screen, add
   `https://www.googleapis.com/auth/drive.metadata.readonly`, and add your
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

## Sync configuration behavior

The browser starts at **My Drive**, but browsing does not select anything for
sync. The user must explicitly choose **Use My Drive**, **Use this Shared
Drive**, or **Use this folder** before saving. A Shared Drive or shared folder
can be opened by pasting its full `https://drive.google.com/.../folders/...` URL
or its folder ID.

The intended first successful run recursively imports all existing supported
documents inside the selected boundary. Subsequent scheduled runs use a durable
cursor to process only new, changed, moved, or deleted documents since the last
successful run; they do not re-ingest every unchanged document each hour.

Enumerating all Shared Drives by name requires the broader `drive.readonly`
scope, so the metadata-only preview does not silently request it.

The **Only me**, **This workspace**, and **Company** options record the intended
future knowledge scope. **Hourly**, **Daily**, and **On demand** record the
intended cadence, while **Allow**, **Ask**, and **Block** record the connector
read policy. They are configuration only in this slice. Durable scheduler
dispatch, source rows, content ingestion, backfill, cursor processing, ACL
projection, and memory updates remain blocked on the common source/fact
foundation.

Disconnecting revokes the OpenGeni connection locally. It deliberately does not
call Google's project-wide token revocation endpoint, which can invalidate
other grants for the same Google OAuth project. Reconnect replaces the
credential in place and refuses a different Google account; disconnect first
to switch accounts.
