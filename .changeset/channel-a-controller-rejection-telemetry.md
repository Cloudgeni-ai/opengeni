---
"@opengeni/api-router": patch
---

A browser or computer controller that refuses a request with its own 4xx (for example a stale computer target) is now counted in Channel-A failure telemetry as a rejected request with that status, not as an unexpected 500. The API response was already the controller's 409, but the failure counter and warning log reported every such refusal as an unexpected internal error, which made computer reads look like they were failing with 500s.
