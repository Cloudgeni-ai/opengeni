<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may move. Code wins.

# Lazy Sandbox Provisioning

`OPENGENI_SANDBOX_LAZY_PROVISION=true` defers provisioned sandbox creation until the first sandbox-backed operation in a turn. It is effective only when `sandboxOwnershipEnabled` is also true; with either flag off, the owned-sandbox path remains eager.

The worker still computes the stable manifest environment at turn start. That same object feeds both `runtime.buildAgent(...)` and the eventual `resumeBoxForTurn(...)` call, so the SDK's provided-session manifest check sees the same environment before and after the box exists. Repository sessions get the stable git-auth pointer env eagerly (`OPENGENI_GIT_TOKEN_FILE`, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`); only the run-scoped GitHub token value is minted later by the provisioner and passed to `runOwnedSandboxSetup(...)` as an off-manifest seed.

While unprovisioned, the turn injects a `RoutingSandboxSession` backed by a synthetic default backend:

- `kind: "unprovisioned"`
- `sandboxId: null`
- `session.state.manifest === agent.defaultManifest` by reference

That reference identity is the invariant. The OpenAI Agents SDK's `applyManifestToProvidedSession(...)` compares current and target manifests; when both point at `agent.defaultManifest`, the delta is empty, so the SDK does not throw or write a new manifest before the real box exists. On the first default-pointer sandbox op, the routing proxy calls the in-process provisioner and then switches its backend state to the real established session.

The provisioner is a memoized promise scoped to one turn. Parallel tool calls share the same establish attempt. A configured host run-credential resolver does not by itself make a turn eager: the worker resolves its exact frozen attempt/group material once before model preparation so partial `auth_needed` state is available as bounded model context and reconnect UI, but sandbox materialization, renewal, leases, and exact-attempt cleanup all remain absent until the first sandbox operation. Signed file resources and generated-video materialization still select the eager path because their verified paths must exist before the first model boundary. The provisioner runs:

1. worker-shutdown check
2. lazy run-scoped Git token mint, if repo resources need one
3. `resumeBoxForTurn(...)`
4. host run-credential materialization of the already-resolved exact material on that lease, before setup or the waiting provider operation, followed by renewal
5. `runOwnedSandboxSetup(...)` against the un-proxied real session
6. lease heartbeat and warm-meter tick

Desktop work is not part of provisioning. Registering the computer-use tools is
side-effect free; the first actual computer action idempotently starts the display
stack and only then begins its optional proof recording. A human viewer attach has
the separate API-direct lazy path that starts the display and resolves the stream
port. A shell/filesystem-only turn never starts Xvfb, XFCE, ffmpeg, or a stream
tunnel.

It emits existing `sandbox.operation.started/completed/failed` events with `name: "sandbox.provision"` around the whole establish. One logical provision carries one `provisionId` from start through its terminal event plus an `internalAttempts` count. Failed terminal events add only bounded structural fields: `failureCategory`, `failureStage`, `failureCode`, `expectedTransition`, and `retryable`; the exact source diagnostic remains in the existing `error` field. The closed categories are create, resume, exec readiness, sibling warming, lease supersession, drain/capture wait, archive recovery, provider transport, configuration, and unknown. Classification follows typed errors, out-of-band boundary stages, and provider status/code evidence rather than raw-message heuristics. Failures propagate to the awaiting sandbox operation; the SDK then surfaces them through its normal tool-error path.

Retries are deliberately narrow: only ownership-fenced lease supersession/transition and explicitly retryable archive-integrity outcomes get two short retries inside the provisioner. A typed provider transport failure is attributable but does not license replay because provider create may be outcome-unknown. `SandboxImageConflictError` is not retried because the operator action is to resolve the live image conflict. On final failure, all waiters reject. A terminal result remains memoized for the frozen turn, while an exhausted safe lifecycle-transition result releases the memo so a later sandbox operation can re-read changed durable lease state under a new logical `provisionId`.

Metrics deliberately keep the two levels separate. `opengeni_sandbox_provisions_total` and `opengeni_sandbox_provision_duration_seconds` record one terminal logical outcome, with expected lifecycle transitions distinct from actual failures. `opengeni_sandbox_provision_attempts_total` and its duration histogram record internal physical attempts/retries. Correlation ids, session ids, sandbox ids, group ids, provider instance ids, and error text are never metric labels.

Turn cleanup is conditional. If the provisioner never ran, there is no lease,
timer, recording, run-credential materialization/renewal, or box to release. If it ran or is still in flight, the activity
waits briefly for it to settle, then uses the same release/snapshot finalization
path as eager ownership. Recording cleanup exists only when computer-use actually
started one.

Machine-primary Connected Machine turns are not lazy. They still establish the `SelfhostedSession` directly at turn start, never create a phantom cloud box, and bill zero cloud warm-seconds.

Canonical code:

- `apps/worker/src/activities/agent-turn.ts`
- `apps/worker/src/activities/environment.ts`
- `apps/worker/src/sandbox-routing.ts`
- `packages/runtime/src/index.ts`
