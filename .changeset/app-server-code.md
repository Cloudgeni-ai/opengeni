---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/react": minor
---

Apps can carry server code. A version's JavaScript modules run on Cloudflare Dynamic Workers when the page calls `site.server.fetch(path, init)` in `@opengeni/sdk/site`, as the app rather than the viewer: tool calls (listed in the server bundle's `tools`) use only the workspace's shared connector accounts, outbound fetches may carry listed vault secrets, and app data writes are the app's. Code that uses tools or secrets runs only for signed-in workspace members who may use them; everyone else is refused. Code versions and rolls back with the app. Managers read runs with `getAppServerStatus` and `listAppServerRuns` in the SDK client and the `app_server_runs` and `app_server_run` agent tools; the app header shows one line while the newest run fails or the code is paused. Off unless `OPENGENI_SITES_SERVER_CODE_ENABLED` is set and the sites gateway has a `LOADER` binding. See docs/app-server-code.md.
