# Excel add-in

The Opengeni Excel add-in puts an Opengeni chat in Excel's side pane and lets
agents work live in the open workbook through one tool, `excel_run`. It works in
Excel on the web, Windows and Mac.

## Pieces

- **Manifest.** The web app serves `/office/manifest.xml` for its own public
  origin (`apps/web/src/office-manifest.ts`). The add-in id is derived from
  that origin, so two deployments never collide. It adds an Opengeni button to
  the Home tab and needs ExcelApi 1.7 and `ReadWriteDocument`.
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
  `@opengeni/react`. Messages sent from the pane carry `modelContext` naming
  the workbook, so the agent knows which workbook "here" is, and the current
  selection (`selection-context.ts`): the active sheet, the selected range and a
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
  by a two-minute ticket from `POST /v1/office/workbook-tickets`. Nothing is
  stored: a workbook is reachable exactly while its pane is connected. Runs
  route over NATS request/reply to the API instance holding the socket, and
  `GET /v1/office/workbooks` collects the person's open workbooks from every
  instance with one short presence query.
- **Tool.** `excel_run` (`apps/api/src/mcp/excel-tools.ts`) runs Office.js code
  as the body of an async function inside `Excel.run`, in a workbook of the
  person the turn acts for, and returns its JSON result, `console.log` lines,
  or Office's error code, message and failing statement. It belongs to the
  browser and computer capability. Where authorized, its schema is in the
  first request with the goal and wait tools, so an Excel request starts with
  `excel_run` instead of a tool search.

## Behaviour to keep

- An agent reaches only the workbooks of the person its turn acts for, from any
  of that person's chats, not only the pane's.
- A run whose result never arrives is reported as unknown, never as failed: the
  code may have changed the workbook.
- The sign-in window opens straight from the click (`promptBeforeOpen: false`)
  and falls back to Office's "allow this window" prompt only when a popup
  blocker stops it.
