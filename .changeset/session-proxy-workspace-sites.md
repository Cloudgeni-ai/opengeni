---
"@opengeni/sdk": minor
---

`createSessionProxyHandler` accepts `sites: true` to read the workspace's Sites without naming a session, so a host can show a page that belongs to the workspace rather than to one chat with `SiteList` or `SiteDetail`. Reads use Opengeni's own authorization for the signed-in user; rollback and status changes stay closed.
