---
"@opengeni/agent-proto": minor
"@opengeni/api-router": minor
"@opengeni/codex": minor
"@opengeni/config": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/documents": minor
"@opengeni/events": minor
"@opengeni/github": minor
"@opengeni/observability": minor
"@opengeni/runtime": minor
"@opengeni/storage": minor
"@opengeni/worker-bundle": minor
---

Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.
