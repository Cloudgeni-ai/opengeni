---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Add a provider-neutral host run-credential port with frozen turn/session lineage,
off-manifest environment and file generations, proactive renewal, attempt-safe
cleanup with bounded generation retention, output redaction hints, and structured
reconnect UI support. Hosts can explicitly opt a frozen target out, and the
POSIX materializer supports both Linux `flock` and a portable directory-lock
fallback with cross-platform base64 decoding.
