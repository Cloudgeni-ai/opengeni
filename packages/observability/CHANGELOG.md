# @opengeni/observability

## 0.5.2

### Patch Changes

- Updated dependencies [7dbd057]
  - @opengeni/contracts@0.39.2

## 0.5.1

### Patch Changes

- Updated dependencies [ce823ce]
  - @opengeni/contracts@0.39.1

## 0.5.0

### Minor Changes

- 33166b0: Export the canonical namespace and Grafana dashboard selectors used by the
  shared self-hostable Prometheus and Grafana distribution.

## 0.4.17

### Patch Changes

- Updated dependencies [6eb0b23]
  - @opengeni/contracts@0.39.0

## 0.4.16

### Patch Changes

- Updated dependencies [c0f8e40]
  - @opengeni/contracts@0.38.3

## 0.4.15

### Patch Changes

- Updated dependencies [4502474]
  - @opengeni/contracts@0.38.2

## 0.4.14

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1

## 0.4.13

### Patch Changes

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/contracts@0.38.0

## 0.4.12

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0

## 0.4.11

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/contracts@0.36.1

## 0.4.10

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0

## 0.4.9

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0

## 0.4.8

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0

## 0.4.7

### Patch Changes

- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0

## 0.4.6

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0

## 0.4.5

### Patch Changes

- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
  - @opengeni/contracts@0.31.2

## 0.4.4

### Patch Changes

- Updated dependencies [9c4d73d]
  - @opengeni/contracts@0.31.1

## 0.4.3

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/contracts@0.31.0

## 0.4.2

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0

## 0.4.1

### Patch Changes

- Updated dependencies [dd71248]
  - @opengeni/contracts@0.29.0

## 0.4.0

### Minor Changes

- 38ba6bc: Add bounded routed-sandbox provider operation observations and the fail-safe
  Prometheus observer used by API-direct and worker turn execution.

## 0.3.0

### Minor Changes

- ac924ca: Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

  Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

  `@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.

## 0.2.1

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.
