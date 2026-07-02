# @opengeni/api-router

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/agent-proto@0.2.0
  - @opengeni/codex@0.2.0
  - @opengeni/config@0.2.0
  - @opengeni/core@0.2.0
  - @opengeni/db@0.2.0
  - @opengeni/documents@0.2.0
  - @opengeni/events@0.2.0
  - @opengeni/github@0.2.0
  - @opengeni/observability@0.2.0
  - @opengeni/runtime@0.2.0
  - @opengeni/storage@0.2.0
