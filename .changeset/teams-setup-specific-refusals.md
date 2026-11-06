---
"@opengeni/api-router": patch
"@opengeni/react": patch
---

The Teams setup page (`/teams/connect`) now shows the API's own reason when setup is refused, such as "Only a Microsoft 365 Global Administrator or Teams Administrator can connect your organization…", instead of generic permission or conflict text. Setup and account-link refusals carry `details.code: "teams_connection_refused"` and a `details.reason`. When the installer's Opengeni account is already linked to a different Teams account in the workspace, setup says so and offers **Unlink and connect**, which removes only their own link and starts setup again. A conflicting account link from the plugins page now returns a 409 with its reason instead of a server error. `@opengeni/react/ui/api-error` adds `serverRefusalText` and `apiErrorDetailCode`, so a page can show the server's own sentence for refusal codes it knows.
