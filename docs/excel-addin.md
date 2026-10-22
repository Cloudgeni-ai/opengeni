# Excel add-in

The Opengeni Excel add-in puts an Opengeni chat in Excel's side pane and lets
agents work live in the open workbook through one tool, `excel_run`. It works in
Excel on the web, Windows and Mac.

## Pieces

- **Manifest.** The web app serves `/office/manifest.xml` for its own public
  origin (`apps/web/src/office-manifest.ts`, built with the SDK's
  `officeAddinManifest`). The add-in id is derived from that origin, so two
  deployments never collide. It adds an Opengeni button to
  the Home tab and needs ExcelApi 1.7 and `ReadWriteDocument`. A deployment
  that lists its add-in in Microsoft's add-in store sets
  `OPENGENI_OFFICE_ADDIN_PROVIDER_NAME` to the store publisher's name (the
  store requires them to match) and `OPENGENI_OFFICE_ADDIN_SUPPORT_URL` to a
  public help page; the support URL otherwise defaults to `/excel`. The
  user-facing help page is `docs-site/guides/excel-add-in.mdx`.
- **Install page.** `/excel` in the web app (public, linked from the account
  menu as "Excel add-in") shows the steps for the person's platform, each
  starting from the downloaded manifest file: upload it in Excel on the web;
  on Mac, drop it in Excel's `wef` folder through Finder's Go to Folder; on
  Windows, add it through a shared-folder Trusted Add-in Catalog. Mac and
  Windows also offer an optional one-line Terminal or PowerShell command (the
  Windows one lists the file under the per-user `WEF\Developer` registry key).
  For a whole organization it shows the Microsoft 365 admin center's "Upload
  custom apps" with the manifest link. When no workbook is connected, `excel_run` gives the agent this
  link to pass on. No connected machine is involved: the pane talks to the API
  directly.
- **Pane.** `apps/web/office/` (built by `vite.office.config.ts` into
  `dist/office/`). Sign-in, a workspace picker and the packaged chat UI from
  `@opengeni/react`, wired up with the add-in kit in `@opengeni/sdk/office`.
  The workbook joins the workspace picked in the pane. Messages sent from the
  pane carry `modelContext` naming the workbook, so the agent knows which
  workbook "here" is, and the current selection (`selectionContextItem`): the active sheet, the selected range and a
  sample of its displayed values and formulas (at most 20 rows by 8 columns of
  its filled part). The selection shows as a pill above the composer; the
  person can leave it out, and selecting something else brings it back.
- **Sign-in.** The pane opens the deployment's `/native-sign-in` page in an
  Office dialog with `platform=office` and PKCE. The page redirects to
  `/office/auth-callback.html` on the same origin, which hands the code to the
  pane with `Office.context.ui.messageParent`; the pane redeems it for its own
  revocable credential. The API accepts that redirect only for the
  deployment's own web origins (`nativeAppRedirectAllowed`). Sign out revokes
  the credential.
- **Relay.** `apps/api/src/office-workbooks.ts`. The pane holds one WebSocket
  (`/v1/office/workbooks/live`, subprotocol `opengeni-office-v1`) authenticated
  by a two-minute ticket from
  `POST /v1/workspaces/{workspaceId}/office/workbook-tickets`, which needs
  `sessions:control` there and is refused to an API key acting as itself. The
  ticket binds the socket to that person in that workspace. Nothing is stored:
  a workbook is reachable exactly while its pane is connected. Runs route over
  NATS request/reply to the API instance holding the socket, and
  `GET /v1/workspaces/{workspaceId}/office/workbooks` collects the person's open
  workbooks there from every instance with one short presence query.
- **Tool.** `excel_run` (`apps/api/src/mcp/excel-tools.ts`) runs Office.js code
  as the body of an async function inside `Excel.run`, in a workbook of the
  person the turn acts for, and returns its JSON result, `console.log` lines,
  or Office's error code, message and failing statement. It belongs to the
  browser and computer capability. Where authorized, its schema is in the
  first request with the goal and wait tools, so an Excel request starts with
  `excel_run` instead of a tool search.

## Behaviour to keep

- An agent reaches only the workbooks its turn's person connected to its own
  workspace, from any of that person's chats there, not only the pane's. The
  same person's workbook in another workspace is out of reach, so a product
  whose users share one service credential stays isolated per workspace.
- A run whose result never arrives is reported as unknown, never as failed: the
  code may have changed the workbook.
- The sign-in window opens straight from the click (`promptBeforeOpen: false`)
  and falls back to Office's "allow this window" prompt only when a popup
  blocker stops it.

## A branded add-in for a product that embeds Opengeni

A product that embeds Opengeni can ship the same add-in under its own name, so
its users chat with the product's agents in Excel. Its server keeps the
Opengeni credential and passes calls through, as for any embed. The pieces
come from `@opengeni/sdk/office` and `@opengeni/react`:

- **Manifest.** Serve `officeAddinManifest({ id, name, description, origin, ... })`
  from the product's origin. Make the id once (for example with
  `officeAddinId("<product>-excel")`) and keep it forever; raise `version`
  when the manifest changes. List the sign-in provider's origin in
  `appDomains` if the sign-in dialog navigates there.
- **Pane page.** Load office.js from Microsoft's CDN, then render the
  product's `SessionApp` (or `OpenGeniChat`) with the product's headers and
  workspace. Start a `WorkbookLink` with
  `ticket: () => client.createOfficeWorkbookTicket(workspaceId)` and
  `baseUrl` set to the product's Opengeni passthrough, such as
  `"/api/opengeni"`. Follow Excel's theme with `officeTheme` and
  `watchOfficeTheme`, and send `workbookContextItem` plus
  `selectionContextItem` (fed by `watchSelection`) as `messageContext`.
- **Sign-in.** A pane on Excel on the web runs in a third-party iframe, where
  the product's own session cookie may not arrive. Sign in with
  `openOfficeDialog(url)`, a top-level window on the product's origin, and
  have the page it lands on send a short-lived credential back with
  `office().context.ui.messageParent`.
- **Server passthrough.** With the packaged session proxy, set
  `office: true` in `createSessionProxyHandler`: it mints workbook tickets as
  the signed-in user (`asUser`), so each person's workbooks stay theirs. To
  render `SessionApp` in the pane with `apiBaseUrl` set to the proxy, also set
  `sessionApp: true`; without it the app cannot load its workspace. Pass
  the WebSocket upgrade for `<proxy base>/v1/office/workbooks/live` through to
  the Opengeni API's `/v1/office/workbooks/live`. The ticket, not a cookie or
  header, authenticates the socket.
- **Agents.** Allow the first-party `excel_run` tool for the product's chats.
  Set `OPENGENI_OFFICE_ADDIN_NAME` to the add-in's name and
  `OPENGENI_OFFICE_ADDIN_INSTALL_URL` to the product's install page, so agents
  name the right add-in and link the right page when no workbook is connected.

