---
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/api-router": minor
"@opengeni/db": patch
"@opengeni/core": patch
---

Fix embedded artifact viewing for external users by resolving fresh effective workspace grants, checking exact session associations on every request, and binding live editor tickets to their source session. Keep editor authority and reconnect reads current when clients or sessions change, and allow retrying temporary viewer configuration failures.

Source-bound editor sockets renew a 15-second lease through the host proxy, rechecking product authorization; existing unbound console sockets are unchanged. Compact authenticated source tickets remain within the existing wire limit.

Add server-only `@opengeni/sdk/session-proxy` helpers. Stream embedded Site HTML with backpressure and cancellation and enforce a 25 MiB actual-byte ceiling; oversized streams fail with `site_html_too_large`. Preserve the console's existing shared artifact components and list behavior.

Allow PostgreSQL test fixtures to use an explicitly configured native server while preserving restricted-role and FORCE-RLS verification.