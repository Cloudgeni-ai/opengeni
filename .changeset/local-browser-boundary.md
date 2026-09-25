---
"@opengeni/config": minor
"@opengeni/api-router": minor
---

Guard the unauthenticated local development API against browser attacks. In `local` access mode with `OPENGENI_ENVIRONMENT=local`, the API now answers only requests whose `Host` names this computer (loopback, `host.docker.internal`, or the hosts of `OPENGENI_WEB_BASE_URL`, `OPENGENI_PUBLIC_BASE_URL`, `OPENGENI_MCP_URL`, `OPENGENI_GITHUB_APP_MANIFEST_BASE_URL`, and the new `OPENGENI_LOCAL_ALLOWED_ORIGINS`), which blocks DNS rebinding. Browser requests are accepted only from the configured web origin, the API's own address, or an exact origin listed in `OPENGENI_LOCAL_ALLOWED_ORIGINS`; any other `Origin` gets 403, and local mode no longer answers with wildcard CORS. Requests without an `Origin` (the SDK, servers, sandbox callbacks) are unaffected. Managed and configured access modes, and local access mode under any other `OPENGENI_ENVIRONMENT`, are unchanged.
