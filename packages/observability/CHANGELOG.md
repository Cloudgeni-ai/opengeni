# @opengeni/observability

## 0.8.9

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/contracts@2.7.0

## 0.8.8

### Patch Changes

- 09beefa: Attribute fatal API startup and runtime failures with secret-safe structural diagnostics, drain pending OTLP exports for a bounded interval, and preserve the required nonzero process exit.

## 0.8.7

### Patch Changes

- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
  - @opengeni/contracts@2.6.0

## 0.8.6

### Patch Changes

- Updated dependencies [76d6396]
- Updated dependencies [b5071cf]
  - @opengeni/contracts@2.5.0

## 0.8.5

### Patch Changes

- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
  - @opengeni/contracts@2.4.0

## 0.8.4

### Patch Changes

- 4d83368: Separate worker-claim queue state from prompts genuinely waiting behind work, keep rapid sends on stable chat and queue surfaces, and make local development fail fast when schema or aggregate runtime readiness is lost.
- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [b2cd0f0]
  - @opengeni/contracts@2.3.0

## 0.8.3

### Patch Changes

- Updated dependencies [4be2055]
- Updated dependencies [de3f376]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [e91d89e]
- Updated dependencies [5d664d8]
  - @opengeni/contracts@2.2.0

## 0.8.2

### Patch Changes

- Updated dependencies [ab81e47]
  - @opengeni/contracts@2.1.1

## 0.8.1

### Patch Changes

- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [5b509be]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [29a44c2]
- Updated dependencies [48b9f09]
  - @opengeni/contracts@2.1.0

## 0.8.0

### Minor Changes

- 747222a: Add content-free compatibility-lane telemetry for the organization-tenancy migration. `opengeni_tenancy_compatibility_lane_uses_total{lane}` counts live uses of a bounded legacy lane - a `legacy_user` connection resolved for accepted use, a workspace-scope connection ref with no connection id taking the pre-snapshot resolution, and a `/workspace` mutation refused `authority_unattributed`. The closed lane set is `TENANCY_COMPATIBILITY_LANES`; the lane name is the only label, an unreviewed name is ignored instead of minting a series, every lane is published at zero on startup so a dormant lane is distinguishable from an unwired one, and a registry failure is swallowed so counting can never change an authorization or credential outcome. This is a use rate, deliberately not a burndown gauge: `docs/organization-tenancy.md` records why none of the tenancy compatibility populations is drainable on the current write paths, and which lanes are intentionally left uninstrumented.

### Patch Changes

- Updated dependencies [1c78ed0]
- Updated dependencies [f4afa19]
- Updated dependencies [8583779]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
- Updated dependencies [6d22ab5]
  - @opengeni/contracts@2.0.0

## 0.7.11

### Patch Changes

- Updated dependencies [b05130a]
- Updated dependencies [55e0417]
  - @opengeni/contracts@1.4.0

## 0.7.10

### Patch Changes

- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
  - @opengeni/contracts@1.3.0

## 0.7.9

### Patch Changes

- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [91d5caf]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [e9aabaa]
- Updated dependencies [1f860f0]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [4eb7abd]
- Updated dependencies [89d4ab3]
- Updated dependencies [7454580]
- Updated dependencies [16cbd7b]
- Updated dependencies [30ba620]
- Updated dependencies [d168b8f]
- Updated dependencies [6860c5f]
- Updated dependencies [f72563d]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
- Updated dependencies [c297fc0]
  - @opengeni/contracts@1.2.0

## 0.7.8

### Patch Changes

- 31231dc: Expose bounded configured and effective sandbox rollout state for every API and worker workload revision.
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [eeb7cb6]
- Updated dependencies [c3f0598]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/contracts@1.1.0

## 0.7.7

### Patch Changes

- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1

## 0.7.6

### Patch Changes

- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0

## 0.7.5

### Patch Changes

- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0

## 0.7.4

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/contracts@0.49.0

## 0.7.3

### Patch Changes

- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0

## 0.7.2

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/contracts@0.47.0

## 0.7.1

### Patch Changes

- Updated dependencies [3d74340]
  - @opengeni/contracts@0.46.0

## 0.7.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [733c22f]
  - @opengeni/contracts@0.45.0

## 0.6.2

### Patch Changes

- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
  - @opengeni/contracts@0.44.1

## 0.6.1

### Patch Changes

- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/contracts@0.44.0

## 0.6.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

### Patch Changes

- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [dcfe6eb]
- Updated dependencies [ad9123b]
- Updated dependencies [31666e2]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
- Updated dependencies [5fcad0a]
  - @opengeni/contracts@0.43.0

## 0.5.16

### Patch Changes

- Updated dependencies [2cd6dce]
  - @opengeni/contracts@0.42.1

## 0.5.15

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/contracts@0.42.0

## 0.5.14

### Patch Changes

- Updated dependencies [ef78ecf]
  - @opengeni/contracts@0.41.4

## 0.5.13

### Patch Changes

- 1385585: Bound active turn memory, make worker admission cgroup-aware, and replace paused-prompt queue pressure with eligible Temporal backlog and slot saturation metrics.
- Updated dependencies [dfcf698]
  - @opengeni/contracts@0.41.3

## 0.5.12

### Patch Changes

- e627d88: Keep known-cold sandbox views passive, fence delayed live-read invalidations across draining transitions, and expose bounded structural Channel-A failure diagnostics without leaking provider details.

## 0.5.11

### Patch Changes

- Updated dependencies [e2edfbc]
  - @opengeni/contracts@0.41.2

## 0.5.10

### Patch Changes

- 56f612b: Isolate read handles from process-capable handles, replace Modal's transport in place when its command-router URL rotates, rebuild the exact lease-fenced handle once for side-effect-free reads after a typed provider outage, and correlate handle recovery safely across API and reaper logs.

## 0.5.9

### Patch Changes

- 81a51ac: Settle abandoned turn workspace admissions only after the exact attempt's physical writers drain, while preserving eager cancellation holder release and late sandbox provisioning safety. Add privacy-preserving sandbox lease correlation keys to rendered lifecycle logs.

## 0.5.8

### Patch Changes

- Updated dependencies [2727236]
  - @opengeni/contracts@0.41.1

## 0.5.7

### Patch Changes

- Updated dependencies [bb9a346]
  - @opengeni/contracts@0.41.0

## 0.5.6

### Patch Changes

- Updated dependencies [fed43cf]
  - @opengeni/contracts@0.40.0

## 0.5.5

### Patch Changes

- Updated dependencies [200586a]
  - @opengeni/contracts@0.39.5

## 0.5.4

### Patch Changes

- Updated dependencies [70ced80]
  - @opengeni/contracts@0.39.4

## 0.5.3

### Patch Changes

- Updated dependencies [5d8bb99]
- Updated dependencies [34c5cdb]
  - @opengeni/contracts@0.39.3

## 0.5.2

### Patch Changes

- 78a1577: Separate expected sandbox path misses from actual provider-operation failures in metrics and alerts.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- Updated dependencies [7dbd057]
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
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
