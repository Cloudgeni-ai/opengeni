---
"@opengeni/sdk": minor
"@opengeni/desktop": minor
"@opengeni/react": minor
---

The desktop kit now fits a product whose web app has its own routes and its own server.

- `webPaths` in the desktop kit's config says where the product's web app shows a workspace, a session, the inbox and settings. The app reads links, reopens the last page and opens notifications and menu commands with it. `parseAppLink`, `parseComputerConnectLink` and `computerConnectUrl` take the same `AppWebPaths`; `OPENGENI_WEB_PATHS` is Opengeni's own web app and stays the default.
- The "Open in app" handoff uses the app's own scheme: `parseAppLink(url, { scheme })`, `appHandoffUrl(url, scheme)` and `openInAppUrl(url, scheme)`.
- `allowOtherServers: false` hides "Use another server" on the first-run page, and the app then signs in to its own server only. Its messages name the configured server instead of Opengeni's.
- `agentPath`, `agentConfigDir` and `adoptStandaloneAgent` pass through to `ThisComputer`, so an app can keep its own agent apart from a separately installed one.
