# @opengeni/agent-proto

## 4.3.1

### Patch Changes

- fda625e: Upgrade the Bun runtime, bundler, test runner and package-manager pins to 1.4.3,
  and use exact-pinned tsrs for CLI typechecks while retaining stable TypeScript
  for declaration emission and editor/tooling compatibility. Preserve strict
  protobuf partial-constructor checks under TypeScript 7.1 without changing the
  wire codec, and make existing source annotations compatible with the new checker.
  Regenerate the checked-in Site browser runtime with the pinned Bun bundler.
- b20c9b2: Retain bounded agent-update blocker categories/counts and show their report age
  and elapsed holds in Machines and fleet, without disclosing private session IDs. Distinguish controller work
  from native request admission without changing update safety, killing work or
  adding command deadlines. Older agents that cannot identify a blocker remain
  explicitly unspecified. These diagnostics do not establish the cause of an earlier
  hold whose admission snapshot was not retained.
- fa5347a: Use prefetched receiver-issued monotonic delivery tokens for Connected Machine reply recovery and streamed command deadlines, without an extra round trip on warm calls. Machine clock skew and corrections no longer reject valid control requests or poison replay admission. Expired and conflicting deliveries return prompt, non-retryable errors preserving uncertain prior outcomes. Mixed protocol versions retain conservative one-shot delivery.

## 4.2.0

### Minor Changes

- 641e179: A finished command's stored output is now released on its runner in one answered exchange, for foreground and background commands alike. The agent serves a new `OpRelease` request (advertised as `capabilities.op_release`): it drops the operation at once and confirms the release in its answer, so the release settles right where the output is stored, while the agent is live from the command, and nothing about the command is left for a later maintenance pass. When the storing process dies first, the agent's own operation inventory recovers the release, so maintenance never sends such an agent anything to release output. Every request Opengeni sends on its own behalf carries `Opengeni-No-Wake`, which a compute host answers itself instead of waking a sleeping sandbox; an unanswered one records nothing and is left to the agent's next inventory. The agent remembers every operation it has started for longer than Opengeni may resend a start for it, independent of output retention and across an in-place update, so a released operation never runs again. Connected Machine agents without the capability keep the existing final acknowledgement and later observation; a compute sandbox whose agent lacks it is refused as an image built with an older agent.
- 641e179: The agent now reports the operations it still runs or retains (a new `operation_inventory` agent event), on every connection and again while it holds completed output nobody released, and the API answers each page in that same exchange with the operations to end. Every OpStart carries the connection generation it was dispatched under, which the agent stores with the operation. A command decides by its custody: output Opengeni has not stored is never ended but collected while the agent is talking, and stored output is ended and its release recorded. Work without a command, such as a command deleted with its chat, is ended when it started under an earlier connection generation and is otherwise kept, never ended for its age. So a runner process that comes back after another process took its connection no longer keeps running commands Opengeni already settled, and output whose storing process died is recovered by the agent itself. The agent starts every such exchange, so a sleeping compute sandbox is never woken for it. Agents that do not send the event keep the earlier behaviour.

## 4.1.3

## 4.1.1

### Patch Changes

- c602300: Fix large Connected Machine writes for machine-addressed operations, including run_on. Negotiate epoch-zero transactional upload support without inventing session epochs or replaying mutations. Older transactional agents receive a preflight 256 KiB limit and update guidance; nonzero session transfers remain compatible. Large machine-addressed transfers require the corresponding native agent release.
- 91dc10d: Carry producer-selected relay owner routes through stream descriptors so multi-replica terminal and frame streams connect without ingress affinity. Relays authenticate and proxy directly to the channel owner, preserving its replay and epoch fences; scoped terminals refresh the route after owner loss without restarting the shell.

## 4.0.4

### Patch Changes

- a0c07e5: A browser controller on a Connected Machine that crashed, was stopped uncleanly or failed to start no longer blocks agent updates for the rest of the agent's life. On Linux and macOS the update now waits only until nothing remains of that controller's own process group, then proceeds. Previously the machine refused every managed update with "could not check whether the machine was idle" until the agent was restarted by hand.
- 9482fe0: Report observed command-scope cleanup of background child processes with an
  append-only result notice, preserving structured output and process containment.
- 2708a32: Settle Connected Machine background commands promptly from authenticated runner
  completion events after verified output capture, with retained notification replay
  across reconnects, independent liveness capacity, shared race-safe settlement,
  reconciliation as fallback and independently retryable output release. Delivery-only
  receipts stop redundant notifications without releasing output; failed collection
  retains reconciliation backoff rather than replaying on every notification.

## 3.4.0

## 3.3.0

### Patch Changes

- 190a322: Browser and computer actions on Connected Machines and attached Chrome are faster. The agent now forwards each controller request itself over loopback, instead of starting a shell, curl and base64 for every click, screenshot or state check. Large responses such as screenshots are read back in pieces, so they stay within the message size limit. Older agents that do not advertise this keep using the previous path.

## 3.2.2

## 3.1.2

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
