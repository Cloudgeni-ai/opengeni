# Google Drive

Google Drive is one personal MCP connection. Search, reads, downloads, copies and
uploads call Google's official server at `https://drivemcp.googleapis.com/mcp/v1`.
Opengeni adds file updates, binary overwrites, moves, trash/restore/deletion, sharing
changes and change-feed checkpoint tools under that same connection.

The official server remains in Developer Preview. OAuth branding approval alone
is not approval to read Drive data. Gmail scope verification does not cover Drive.
See Google's [configuration guide](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server)
and [file eligibility rules](https://developers.google.com/workspace/drive/api/guides/drive-mcp-server-file-eligibility).

## Operator setup and availability

Before setting `OPENGENI_GOOGLE_DRIVE_MCP_ENABLED=true`:

1. Obtain Google Workspace Developer Preview access and enable the Drive API and
   Drive MCP API in the OAuth client's project.
2. Configure an OAuth Web application client for an AI-powered agent with the exact
   redirect `<OPENGENI_PUBLIC_BASE_URL>/v1/integrations/oauth/callback`.
3. Include `https://www.googleapis.com/auth/drive.readonly` and
   `https://www.googleapis.com/auth/drive.file` in the project's consent-screen
   scope declaration, justification and demonstration. Complete Google's applicable
   data-access verification and assessment. A pending Gmail review is insufficient.
4. Configure the client in `OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON` under
   `https://accounts.google.com`. This issuer entry also serves Gmail: its client
   must support both connectors' approved scopes. Keep identity-only sign-in on its
   separate `OPENGENI_MANAGED_AUTH_GOOGLE_*` credentials.
5. Test an authenticated read, upload, update, approval and scheduled refresh in
   the intended environment. An unauthenticated `tools/list` is not this proof.

`OPENGENI_GOOGLE_CONNECTOR_SETUP_ENABLED=false` pauses new Gmail/Drive OAuth
acquisition and callbacks. It leaves Google sign-in, existing token refresh,
connection records and ordinary schedules unchanged. The separate Drive MCP flag
is false by default. Catalog setup readiness reflects both gates; the backend
independently enforces them, including manually supplied MCP URLs.

Google OAuth uses offline consent and requires a refresh token. The callback
requires the requested scopes, actual remote tool discovery and a successful
authenticated read. A read-only grant
is not silently accepted as a writable connection.

## Capabilities and limits

The official tools are `copy_file`, `create_file`, `download_file_content`,
`get_file_metadata`, `get_file_permissions`, `list_recent_files`,
`read_file_content`, and `search_files`.

Opengeni's extensions are `update_file`, `overwrite_file_content`, `move_file`,
`trash_file`, `restore_file`, `delete_file`, `create_permission`,
`update_permission`, `delete_permission`, `get_changes_start_token`, and
`list_changes`. Binary overwrite accepts up to 25 MiB and preserves the file ID;
it does not edit native Docs or Sheets. Sharing tools do not transfer ownership.

`drive.file` limits writes to files authorized for the app. Read access to every
file does not grant write access to every file. The extension never requests a
broader scope silently. Google enforces file permissions and organization policies.
The official tools also apply Google's MCP file-eligibility rules. An official-tool
denial never triggers a REST fallback.

Mutations ask by default. The runtime uses the selected personal connection,
rechecks live authority before each API request, refuses redirects, and never
replays an ambiguous mutation. Additional API destinations are restricted to
specific Drive file, permission, upload and change-feed routes. An official tool
with the same name as an extension fails discovery until the collision is reviewed.

## Recurring work

Use ordinary agent schedules for hourly synchronization, daily reports or other
recurring tasks. Select the Drive MCP connection and give the agent its folder,
output and timing instructions. No separate integration scheduler or sync toggle
is created. A change-feed task should process all pages before saving the returned
`newStartPageToken`; content and Knowledge writes retain their ordinary policies.

## Previous native connections

The separate knowledge-source setup, folder sync configuration and artifact-only
publishing setup are retired. No new native source task, native reconnect or
publishing grant is admitted. Previously scheduled native source runs are blocked
before model/session creation; already accepted source fetches are also refused.
Imported documents, connection records and run history are preserved. The console
retains a removal surface for previous connections.

Connect Drive MCP explicitly, then create a replacement ordinary schedule. Old
source selections, tokens, permissions and execution snapshots are never converted
into a broader MCP grant automatically. Users choose the replacement access.
