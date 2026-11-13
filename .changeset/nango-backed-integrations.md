---
"@opengeni/contracts": minor
---

Operators can serve Gmail, Google Calendar, Google Drive and new connectors such as LinkedIn and X through Nango, switched per integration at runtime (docs/nango.md).

- Nango is off unless `OPENGENI_NANGO_SECRET_KEY` is set and an operator allowlists the integration with `set_integration_backend(...)`.
- The catalog lists each service once. While a Google integration is on Nango, its native connections show as needing reconnection and Connect opens Nango Connect; flipping back restores them.
- Organization admins can read Nango usage and estimated cost with `GET /v1/billing/integration-usage`.
