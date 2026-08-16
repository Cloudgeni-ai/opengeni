# @opengeni/agent-proto

## 0.5.1

### Patch Changes

- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- d34dd9a: Add revision-fenced per-command memory and CPU policies for Connected Machines, exact live runner capability gating, and lifecycle-safe Linux operation accounting without introducing default resource limits.

## 0.5.0

### Minor Changes

- b0b2bed: Add unified browser and computer interaction APIs, reusable browser identities, native input, live streaming, and React viewer controls across managed sandboxes and connected machines.

## 0.4.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

## 0.3.0

### Minor Changes

- 3584f26: Op-stream wire additions (all additive; PROTOCOL v1.1): `OpExit.failure_code`
  - `failure_detail` (typed runner-decided deaths — OP_OVERFLOW / OP_SPOOL_IO /
    OP_PIPE_IO — never exit-code sentinels), `OpAttach.window_bytes` (0 = reuse
    the OpStart grant), and heartbeat capacity telemetry
    (`Heartbeat.capacity`/`.admission`: HostCapacitySample + AdmissionTelemetry
    incl. live_ops, op_frames_dropped_total, evicted_unacked_total — the upward
    report the server paces against). The runner now serves the op-stream
    protocol and advertises `Capabilities.op_stream = true`; the server-side
    feature flag still gates use (no flag day).

## 0.2.1

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.
