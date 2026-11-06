---
"@opengeni/sdk": minor
"@opengeni/desktop": patch
---

The desktop app now opens a link to any page of the web app, not only workspaces and sessions. Before, a connector sign-in started in the desktop app finished in the browser, and the browser's "Back to Opengeni" page handed the app the page it started on (for example a workspace's plugins page with the connection result in its address), but the app only read workspace and session links, so it just came forward on whatever page it was showing and never showed the result. Now the app opens that page, with its query kept, on the account for that server and workspace; a page on a server without an account here opens in the browser. `parseAppLink` takes a new `anyPage` option for apps that show the whole web app, and `AppWebPaths` gets an optional `workspaceOf` that reads the workspace any page belongs to (`OPENGENI_WEB_PATHS` reads `/workspaces/:id/…`). Without `anyPage` nothing changes, so phone apps still open those pages in the browser.
