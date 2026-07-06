# @opengeni/config

## 0.4.0

### Minor Changes

- 1e7a243: Support PRIVATE-registry Modal sandbox images via `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`.

  The Agents-extension Modal backend resolves `OPENGENI_MODAL_IMAGE_REF` (and any pack
  `sandboxImage` that overrides it) with `Image.fromRegistry(tag)` and no secret, so it could
  only pull PUBLIC images. New optional setting `modalImageRegistrySecret` (env
  `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`) names a Modal Secret holding `REGISTRY_USERNAME` +
  `REGISTRY_PASSWORD`; when set, the runtime resolves that Secret and pre-builds
  `fromRegistry(tag, secret)` ONCE per worker process (`ensureModalRegistryImage`, awaited in
  `createOpenGeniWorker` boot) and the Modal provider selects it via
  `ModalImageSelector.fromImage(...)`. When unset the behavior is byte-identical to today's
  public-image path (and the modal SDK is never loaded for it). Resume/attach turns never pull
  the image, so they are unaffected.

## 0.3.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

### Patch Changes

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [7bfe593]
  - @opengeni/contracts@0.8.0

## 0.2.5

### Patch Changes

- 5ca067f: ClientConfig gains optional `serverVersion` (the release-train version baked into official server images, surfaced on /healthz and /v1/config/client); the unused `PageInfo`/`paginated()` exports are removed — list endpoints deliberately return bare arrays, and the events route's cursor scheme is the documented exception.
- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0

## 0.2.4

### Patch Changes

- dbe3a19: Keep the stock `.env.example` shell-sourceable and aligned with boot-time settings validation.
- Updated dependencies [e513236]
  - @opengeni/contracts@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/codex@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/codex@0.2.0
