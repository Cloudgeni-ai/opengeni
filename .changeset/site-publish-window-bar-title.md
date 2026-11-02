---
"@opengeni/react": patch
---

In the macOS app, a Site's "Publish to web" page names the window bar instead of keeping the Site's name there. `useWindowBarTitle` takes an optional `fallback` flag: the claim then yields to any other header with a title, as headers in a `WindowBarTitleBoundary fallback` do. The Slack agent create form shows why the Slack workspaces couldn't load, with Retry, instead of asking to add a Slack workspace.
