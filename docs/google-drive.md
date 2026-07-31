# Google Drive source preview

OpenGeni can connect a Google account and browse Drive metadata from the
Capabilities page. This first slice is intentionally a connector preview:

- OAuth and refresh tokens are server-side only and encrypted in the existing
  connection vault.
- OpenGeni requests
  `https://www.googleapis.com/auth/drive.metadata.readonly`.
- The browser can see names, types, timestamps, folder structure, and links. It
  cannot download file content.
- Selecting a file or folder stores connector configuration on the connection.
  It does not create a knowledge source, download a file, run a backfill, or
  update workspace memory.

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

## Source selection behavior

The browser starts at **My Drive**. A Shared Drive or shared folder can be
tested by pasting its full `https://drive.google.com/.../folders/...` URL or
its folder ID. Enumerating all Shared Drives by name requires the broader
`drive.readonly` scope, so the metadata-only preview does not silently request
it.

The **Only me**, **This workspace**, and **Company** options record the intended
future knowledge scope. They are not ingestion or authorization controls yet.
Durable source rows, content ingestion, backfill, sync, ACL projection, and
memory updates remain blocked on the common source/fact foundation.

Disconnecting revokes the OpenGeni connection locally. It deliberately does not
call Google's project-wide token revocation endpoint, which can invalidate
other grants for the same Google OAuth project. Reconnect replaces the
credential in place and refuses a different Google account; disconnect first
to switch accounts.
