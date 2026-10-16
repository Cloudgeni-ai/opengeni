# @opengeni/agent-proto

## 3.1.0

## 3.0.0

## 2.0.1

## 2.0.0

### Minor Changes

- c2f4153: Record why each attached Chrome profile connection ended. Every connection generation change ends that profile's live browser sessions, but the reason only existed in machine logs, so a Chrome-side port close could not be told apart from a crashed native host. The native host now sends a final closing frame naming why it is shutting down (Chrome closed the port, Chrome sent an unreadable message, writing to Chrome failed); an end without that frame means the native host itself vanished, and a hello or message the agent refuses is reported as rejected. The agent includes its recent connection ends in every inventory snapshot, and the server keeps a bounded per-profile history in `attached_browser_devices.connection_history` (rolling migration `0770`). Generations that ended without a report are still recorded: as `agent_restarted` when the whole bridge was replaced, otherwise `unreported` for agents too old to report.

  The bridge is also harder to disconnect by accident. An oversized tab title is truncated and an oversized tab URL makes that tab uncontrollable, instead of either one tearing down the whole profile connection. Fields a newer extension adds are ignored rather than rejected. Native-host diagnostics now go to stderr, never to the stdout channel Chrome reads frames from.

- 8e878ac: Turn screen control on for an already-connected machine, in place, with no reconnect, token or human click. `POST /v1/workspaces/:ws/machines/:enrollmentId/screen-control` (SDK `enableMachineScreenControl`; agent tool `connected_machine_enable_screen_control`) records the consent on the enrollment without a new credential generation. It then sends the live agent the new `credential_renew` control op, and the agent renews its credentials with its install-key proof. The response is `active`, or `pending` with `offline`, `agent_update_required`, `renewal_failed` or `reconnect_required`. Pending consent applies automatically on the machine's next Hello. Each change records a `connected_machine.screen_control.allowed` audit event with the actor.

  Agents advertise `Capabilities.credential_renew`. Mac agents report Screen Recording, Accessibility and Input Monitoring (`MacDesktopPermissions`) on Hello and desktop heartbeats, which surface as `runtime.macPermissions`. `runtime.capabilities.screenControl` says whether the live agent holds the consent. `POST /v1/workspaces/:ws/machines/:enrollmentId/privacy-settings` (SDK `openMachinePrivacySettings`) opens one of those System Settings panes on the Mac. The Connected Machine card shows **Turn on**, then walks the missing Mac permissions from what the machine reports.

## 1.4.4

## 1.4.3

## 1.4.2

## 1.4.1

## 1.4.0

## 1.3.0

## 1.2.0

## 1.1.0

## 1.0.2

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 0.6.1

### Patch Changes

- 6a97313: Publish the runner heartbeat `desktopStatus` field so `@opengeni/api-router` can decode live desktop availability.

## 0.6.0

### Minor Changes

- d08dbb6: Support capability-gated transactional large-file edits on Connected Machines,
  with bounded transfers, verified outcomes, and live authorization checks. Keep
  legacy agent writes compatible and report oversized outbound requests accurately
  instead of marking a healthy agent offline. Native agent support is required;
  unsupported filesystem semantics fail closed.

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
