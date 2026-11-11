---
"@opengeni/react": minor
"@opengeni/api-router": patch
"@opengeni/config": minor
"@opengeni/db": patch
---

`ConnectPanel` now keeps the organization approval help up when a sign-in comes back cancelled or denied with an administrator approval link stored on the attempt, for example after someone leaves Microsoft's "Need admin approval" page with Cancel or "Return to the application without granting consent". It used to treat the cancel as finished and quietly go back to the service list. The help offers the message for IT, the approval link, "Try signing in again" (a fresh setup for the same service unless the host passes `onRetry`) and "Back to connections". A plain cancel that stores no approval link still closes quietly.

`ConnectPanel`, `ConnectChooser`, `ConnectAccounts` and `ConnectionDiscovery` accept `finishInPopup`. Set it when your `onAuthorize` opens the provider's sign-in in a popup: the popup then ends on a small page that closes itself instead of loading your return URL, a second copy of your app, inside it. The closing page now says "Go back to where you started to continue" rather than naming the chat.

Once a service connects, older unfinished setups by the same person for the same service, owner and destination no longer appear in the pending list (`GET /v1/workspaces/:workspaceId/connect/attempts`), so a host's "continue setup" entry for that service goes away. Custom connections (MCP servers, OpenAPI and GraphQL sources) share one provider ID across different services and are never hidden this way.

The page a sign-in popup ends on and the page an administrator sees after the Microsoft approval link can now use the deployment's language: set `OPENGENI_CONNECT_RESULT_PAGE_TEXT_JSON` (fields `lang`, `signInFinishedTitle`, `signInFinishedBody`, `adminApprovedTitle`, `adminApprovedBody`, `adminNotApprovedTitle`, `adminNotApprovedBody`, `closeWindow`). Any field left out stays in English. `@opengeni/config` exports `parseConnectResultPageTextJson` and `ConnectResultPageTextSchema`.
