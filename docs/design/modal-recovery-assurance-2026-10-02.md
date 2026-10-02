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

## Evidence and ownership

Before changes, 137 installed-SDK/native fault tests passed across eight files,
17 restricted-database internal-retention cases passed, and the real database
exhaustion case passed. The four new desired-recovery counterexamples failed.
Final validation is recorded in the implementing PR.

[OPE-640](https://linear.app/cloudgeni/issue/OPE-640/recover-fixed-modal-probes-and-contain-ambiguous-stdin)
owns these focused corrections.
[OPE-641](https://linear.app/cloudgeni/issue/OPE-641/resume-modal-connectivity-waits-automatically-and-checkpoint)
records the durable eventual-continuity requirement under
[OPE-618](https://linear.app/cloudgeni/issue/OPE-618/modal-taskexecstart-name-resolution-failed-ends-the-turn-instead-of).
The existing OPE-618 owner retains its broader rollout and live capture diagnosis.
The DNS root-cause investigation remains separate under OPE-13.
