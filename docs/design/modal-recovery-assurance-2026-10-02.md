# Modal recovery assurance, October 2, 2026

## Finding

Short transport interruptions have safe recovery paths, but current OpenGeni
cannot promise that every Modal DNS failure automatically resumes work after
connectivity returns. A nonfailed parked turn is not proof of eventual recovery.
Error text also cannot establish whether a provider accepted a mutation.

This audit binds source `4fec94157a7bec820b205fa0230264ee075fdae7` and the installed
`modal@0.9.0`, Agents 0.14.3 and grpc-js 1.14.4 contracts. The staging read on
October 2 verified `/healthz` and all eight API/control/turn PID1 revisions at
`7dc8eaf81cc4a278210880d3d5ccfc14f26f4080`. The latter contains the October 2
observation and exhaustion fixes. The audited source has later routed-file
changes; it is not identical to that deployment. No session replay, deployment,
upstream fault injection or customer sandbox mutation was performed for this audit.

The original DNS cause remains unproven. The error predates the recent changes.
September 24's stricter local non-dispatch proof and October 1's removal of SDK
Start transport retries exposed incomplete setup recovery. October 2 additionally
closed raw post-Start output/poll exceptions. These are separate execution phases.

## Dispatch and recovery inventory

| Boundary | Safe action and current limit |
| --- | --- |
| Read-only task/router lookup and local channel readiness | Retry preparation with genuine local non-dispatch proof. Remote DNS wording gives no such proof. |
| Native `TaskExecStart` | Exactly one possibly dispatched Start. Keep the original task/exec UUID and writer reservation; observe that invocation. |
| SDK `TaskExecStart`, ESM and CJS | The pinned patches disable transport replay and retain original task/exec identity. Wait/stdio can recover while the original helper frame exists. |
| Historical `ContainerExec` | No automatic Start replay. A lost response may leave no recoverable provider-generated execution ID. New commands use the native router. |
| Native output/read/Poll | Retry authenticated read-only observation with the original UUID and persisted byte cursors. Require stream EOF and authenticated exit proof. Bounded exhaustion returns uncertainty. |
| Fixed `/bin/true` lease readiness | Same UUID after uncertain ACK, within the original 60-second readiness budget. Budget expiry still has separate worker timeout semantics. |
| Fixed supervision capability probe | This change observes the original UUID after a lost ACK within its existing five-second budget. Success requires exact capability output and zero exit. |
| File-visibility probe | This change observes its original locator after a lost ACK and continues retryable observation throughout its existing 30-second budget. Success requires exact marker output and zero exit. |
| Supervision status/cancel helpers | Existing helper identity, partial output and cursor survive bounded observation failures. Cancellation intent is not process-exit proof. |
| Nonempty retained stdin | Reserve the byte range before one write. This change labels ambiguous native gRPC acknowledgement loss explicitly and tells the worker's model-facing tool to inspect with empty input, without resending. |
| SDK manifest, file/path/runAs, archive capture/hydration and setup | All converge on the patched SDK Start boundary. Automatic continuation after an unwound multi-step helper remains unimplemented. |

Primary sources: `modal-command-router-wire.ts`, `modal-command-control.ts`,
`modal-command-session.ts`, `modal-materialization-verification.ts`,
`turn-tool-cancellation.ts`, `routing/routing-session.ts`, the pinned Modal/Agents
patches, worker `failure-settlement.ts` and `sandbox-resume.ts`, and the database
turn-recovery/claim protocol. See [run lifecycle](../run-lifecycle.md).

[Modal's command documentation](https://modal.com/docs/guide/sandbox-spawn)
separates execution from process/output observation. Its public documentation
does not establish native router Start deduplication or a durable continuation
contract for OpenGeni's SDK setup helpers. We therefore verify the installed
protocol and count physical Starts/writes in actual gRPC fault tests.

## Newly reproduced defects and focused correction

Authenticated TLS/gRPC servers accepted each physical operation and then returned
the same DNS-shaped `UNAVAILABLE` seen in incidents. Four counterexamples failed
against the audited baseline:

1. Capability Start lost its acknowledgement. The helper threw before reading
   the original invocation, although later read-only observation proved success.
2. File-visibility Start did the same. The surrounding file mutation could not
   acquire success merely from the raw provider exception.
3. Repeated read failures exhausted one visibility read window while the outer
   30-second budget still had time. The provider recovered during that budget.
4. Stdin bytes were accepted before an error reply. The worker's actual function
   tool said “Please try again”, which could encourage duplicate input.

The focused change continues only the original fixed probes. It preserves UUIDs,
partial output, stream offsets, exact diagnostics, cancellation, rejection and
non-transport errors. Mixed or contradictory observation evidence cannot grant
another read. It never repeats Start, input or the surrounding file operation.

Input uncertainty is a private typed error carrying the original command and
reserved byte range, with the original cause. The failed child RPC's settlement
does not assert that input bytes were rejected. The retained parent command and
its holder continue to fence workspace capture until exact terminal proof.
Empty reads create no new input reservation or write. The focused rendering
guarantee is the worker's retained-process tool/controller path; a standalone
consumer using the raw SDK default error renderer remains a separate surface.

## Remaining automatic-continuity requirements

These are deliberately separate from the focused probe/input corrections:

- **Exhausted setup recovery:** after five replacements, a sixth genuine
  pre-model pre-dispatch failure permanently sets `sandboxSetupRecoveryExhausted`.
  Work peek and claim reject later wakes, elapsed time, recovered health and
  lease changes. The existing real database test confirms that behavior.
- **Readiness timeout:** prolonged failure becomes `SandboxExecReadinessTimeoutError`.
  A confirmed-disposed unpublished fresh sandbox may be replaced once. A second
  timeout or an attached/resumed sandbox timeout can still fail the turn.
- **Post-model exhaustion:** the special nonfailed setup park does not cover a
  genuine pre-dispatch failure after model execution. Ordinary exhaustion can
  still settle the turn as failed. Model, MCP and setup share the recovery streak.
- **Unwound SDK helper:** exact original command exit or exact provider loss does
  not prove that remaining setup steps completed. `sandboxSetupOutcomeUnknown`
  remains blocked. Replaying the helper would risk repeating earlier effects.

Eventual automatic recovery requires a durable provider-connectivity wait with
paced read-only checks and transactional workflow wakes, plus operation-level
receipts and a verified continuation contract for interrupted SDK setup.
Availability proof may re-arm only the exact accepted operation whose execution
phase is established. Arbitrary wakes, timeout age and DNS prose cannot clear
unknown markers or grant replay authority. Pause, Steer, Cancel and revocation
remain authoritative while waiting.

The acceptance matrix must include outages longer than both readiness and the
five-replacement budget, followed by verified recovery; Start/ACK/read/Poll/input
failures; partial EOF and output; worker restart; concurrent router users;
deadline rotation; and owner cancellation. Every test must count physical
Starts/writes and verify durable session progress, not only a nonfailed status.

## October 4 private host-transport groundwork

`packages/core/src/application/modal-native-worker-host-transport.ts` is an
unused internal transport helper, not an active recovery path or custody issuer.
Its `ogmnp2_` envelope binds the exact body SHA-256, full original V2 scope,
configuration/grant references, action and request ID to a separately derived
HMAC-SHA256 subkey and message domain. Capture/reconciliation/settlement intents
also bind the exact claim, nonce, record/claim revisions, capture and acquisition.
Only an explicitly configured deployment `delegationSecret` selects its root;
ordinary delegated tokens, access-key substitution and the fixed local/test
fallback are excluded. No token, key or derived key is persisted or returned.

The 60-second envelope lifetime bounds transport only, not original custody.
Verification authenticates a previously signed host request, not its named
human, live origin, grant, configuration, native page or physical settlement.
A future narrow host authorizer must independently recheck these source joins,
current expiry and action-specific CAS. The helper is not a public core entry
and has no production consumer, database writer or provider caller. Root disposal
is only in-memory key disposal; waiter rejection, claim expiry and transport
timeout cannot release an acquisition or a physical writer. Actual underlying
namespace/access/read/poll promises must remain counted until all settle.

Raw request bytes are bounded, copied through native typed-array getters and
hashed without caller getters or shared-memory backing. Signing inputs are
strict, own-data JSON; malformed values return fixed errors. These checks do
not replace authenticated provider acquisition or lost-COMMIT-ACK reconciliation.
The earlier audit and all remaining continuity requirements above are unchanged.

## Evidence and ownership

Before changes, 137 installed-SDK/native fault tests passed across eight files,
17 restricted-database internal-retention cases passed, and the real database
exhaustion case passed. The four new desired-recovery counterexamples failed.
Final validation is recorded in the implementing PR.

The implementing PR records the focused correction's validation and ownership.
Durable eventual continuity is tracked separately from the existing rollout and
live capture diagnosis. The DNS root-cause investigation also remains separate.

## Dormant explicit original-read transport, October 4, 2026

`packages/runtime/src/sandbox/providers/modal-original-read-wire.ts` adds only a
private, unwired transport building block. The installed Modal 0.9.0 constructor
reads ambient profile/endpoint settings even with an explicit pair; its advertised
endpoint parameter is not applied, and an empty environment leaves ambient
selection intact. The new narrow grpc-js/protobuf projection instead owns the
explicit sampled pair and HTTPS channel. It uses explicit Node bundled trust
roots (or isolated test roots), not grpc's ambient root-file override. This TLS
policy and endpoint must be included in any future protected configuration
capture; neither the transport nor a copied snapshot establishes that capture.

The sole wire methods are `AuthTokenGet`, `WorkspaceNameLookup` and
`TaskGetCommandRouterAccess`, pinned to the installed SDK source. Each local
observation has one bounded auth/read chain, no retry, and no token-refresh
background task. The namespace result retains whether the actual response used
`workspaceName` or `username`; neither is relabelled as an immutable principal.
Environment selection is retained in the snapshot but these RPCs do not send it.
Router credentials stay ephemeral. Errors omit provider details and causes.

Cancellation requests abort the exact underlying RPC; only its actual callback
settles the promise. The single local observation slot remains held until that
chain settles, and close joins it before closing the owned channel. These facts
describe local observation I/O, not provider-process exit, another writer's
quiescence, a committed capture or permission to resume a helper.

There is no production caller, new public sandbox export, SDK patch, compiler
change or database activation. Canonical authenticated host issuance, protected
original configuration/equality/grant joins, genuine opaque acquisitions and
atomic once-binding/capture ingress remain required before integration. This
building block alone does not address readiness timeout, exhausted recovery,
closed-original continuation or any of the four continuity requirements above.
