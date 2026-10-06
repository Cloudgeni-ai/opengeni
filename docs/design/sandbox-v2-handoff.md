# Sandbox v2: research and implementation handoff

Status: **exploratory draft, disabled by default, not ready to merge or deploy**.
This document maps the accumulated prototype and the decisions still required.
The detailed contract is [sandbox-v2.md](sandbox-v2.md).

## What the work produced

The goal is a cheaper persistent coding workspace with less repeated setup and
less application-owned archive/restore machinery. The proposed unit is one
durable provider machine per sandbox group, shared by its sessions. A small
native command journal retains the identity and result of each invocation.

The branch contains:

- A design for persistent machines, command recovery, demand, authorization and
  coexistence with existing sandboxes.
- A provider research framework and the public-source comparison below.
- A Rust command journal and native process supervisor integration.
- A TypeScript lifecycle/session implementation and local Docker backend.
- Database contracts, a draft maintenance migration, worker/control integration,
  resource and credential owners, and synthetic regression fixtures.

This is substantial prototype code, not just research notes. It currently adds a
parallel implementation: **no legacy sandbox subsystem has been removed** and no
net reduction in production complexity has been established.

## What we care about

The product goal is a persistent computer for each workspace that feels instantly
available and costs very little when unused. Evaluate every provider and design
against these seven priorities; they are targets, not guarantees of this prototype.

| Priority | Desired outcome |
| --- | --- |
| Continuity | Preserve the full mutable filesystem, installed tools and work, plus running processes and their memory across supported pause/resume transitions. |
| Elasticity | CPU and RAM grow with demand and shrink after a burst; unused compute is released and idle cost approaches zero. Evaluate CPU, RAM, billing floors and reclamation separately. |
| Speed | Fast first startup, wake, reconnection and command execution, including after a long idle period. |
| Reliability | Recover from crashes, disconnects and lost replies without losing durable work or blindly repeating commands whose outcome is uncertain. |
| Isolation | Separate customers and workspaces; protect secrets and infrastructure from sandbox code, and preserve current authorization through recovery. |
| Capability | Support real development: terminals, background processes, networking, previews, installed tools and large projects. |
| Cost and simplicity | Low total cost at fleet scale, little operational burden and minimal provider-specific application machinery. Include storage, idle charges and operations, not just active compute. |

### Continuity includes processes, not just disk

- **Disk persistence:** files and installed tools survive, but programs may need
  to restart. A retained disk alone does not preserve a running workspace.
- **Process continuity:** running terminals, servers and other programs resume
  with their in-memory state intact. The target for a planned pause is to freeze
  the workspace and continue it on resume, rather than reconstruct its processes.
- **Connection recovery:** open network connections may still break across a
  pause; clients and services must reconnect. Resuming memory does not guarantee
  that external systems retained the connection or that credentials remain valid.

A paused process makes no progress. Background work that must keep running must
retain active compute demand instead of allowing the workspace to suspend.
Planned pause/resume, cold wake, restart and host failure must each have explicit
disk and process guarantees; success in one does not establish the others.
Restarting a command from a journal is not process continuity.

**Full process continuity across provider pause/resume remains unproven by this
prototype.** Qualification must demonstrate memory, process-tree and terminal
continuity separately from filesystem retention, and document any weaker modes
and required recovery behavior. No provider is selected or qualified here.

## Working thesis and boundaries

Prefer a provider that preserves the whole mutable Linux filesystem, including
installed tools and home directories, while charging close to actual CPU/RAM
consumption. Small active work should not reserve every workspace's possible
peak. Automatic growth, billable floors, host headroom and post-burst reclamation
must be evaluated separately. Auto-suspend is a different property.

Persistent storage and command recovery solve different problems. A command
journal on an ephemeral disk does not make that disk durable. A snapshot API does
not remove application lifecycle machinery if the application must still schedule
captures, fence writes, track snapshots and recover rollback on every stop.

The journal provides at-most-once launch only while authoritative operation
history and disk lineage survive. It does not make arbitrary external effects
exactly-once. Missing receipts, observer failure and timeouts preserve uncertainty;
they do not authorize a replacement command. Guest-written records are recovery
evidence, not an authorization boundary against guest root.

OpenGeni still owns current permissions, accepted work, exact attempts, physical
writer retirement, demand and command ownership. Those obligations remain even
if a provider eventually replaces routine archive and rotation responsibilities.

## Which OpenGeni code changed

Paths below are relative to the repository root. Start with the first file in
each row; adjacent `sandbox-v2-*` modules hold the remaining responsibilities.

| Area | Entry points | Implemented behavior |
| --- | --- | --- |
| Contracts and fresh admission | `packages/contracts/src/sandbox-v2.ts`, `packages/db/src/sandbox-v2-admission.ts`, `packages/config/src/index.ts` | Machine/transition/demand contracts, immutable group engine selection, deployment and workspace gates, separate qualified-provider policy. |
| Database and ownership | `packages/db/drizzle/0638_sandbox_v2_machines.sql`, `packages/db/src/sandbox-v2-schema.ts`, `packages/db/src/sandbox-v2-commands.ts` | Engine claims, machine state, command/input/output receipts, preparation plans, encrypted original credentials, cleanup and background custody. Tenant scoping, RLS and compare-and-set guards. |
| Shared attempt fencing | `packages/db/src/session-attempt-write-fence.ts`, `packages/db/src/session-attempt-writers.ts`, `packages/db/src/index.ts` | Native writers participate in the existing attempt/finalization boundary; changes affect shared code and require legacy regression review. |
| Machine lifecycle | `packages/runtime/src/sandbox/v2/machine-controller.ts`, `docker-backend.ts`, `docker-transport.ts` | Retained transition identity, exact instance ownership, lost-reply reconciliation, local container/volume creation and staged destruction. |
| Guest execution | `agent/crates/opengeni-run/`, `agent/native/command-supervisor/supervisor.c`, `io.h` | Rust command journal, descendant supervision, complete output capture, pipe/PTY input and terminal evidence. Both sandbox Dockerfiles include the binary. |
| Runtime and SDK binding | `packages/runtime/src/sandbox/v2/machine-session.ts`, `journal-client.ts`, `filesystem.ts`, `packages/runtime/src/index.ts`, `apps/worker/src/sandbox-v2-shell.ts` | Retained command handles, accepted-call replay, output cursors, shell tools, bounded text editing and image reading through the ordinary model/tool pipeline. |
| Normal worker path | `apps/worker/src/activities/agent-turn/run.ts`, `native-preparation.ts`, `finalization.ts` | Retained native groups select a concrete native preparation/runtime/finalization path when a provider is installed. Unsupported contracts report unavailable before legacy setup. |
| Credentials and files | `apps/worker/src/sandbox-v2-run-credentials.ts`, `sandbox-v2-credential-renewal.ts`, `sandbox-v2-resources.ts`, `packages/core/src/sandbox-v2-credential-lifecycle.ts` | Original encrypted credential generations, ordered renewal and cleanup, host-only MCP headers, current-turn file grants and immutable delivery metadata. |
| Workspace and media | `apps/worker/src/activities/agent-turn/native-workspace.ts`, `native-generated-image.ts`, `media-artifacts.ts`, `packages/runtime/src/sandbox/channel-a.ts` | Native Skill checkout/publication and search, retained current-turn generated-image placement, and image-history integration. Original operations retain uncertainty across retry. |
| Background work and control | `packages/core/src/sandbox-v2-background-commands.ts`, `sandbox-v2-background-control.ts`, `apps/worker/src/sandbox-v2-control.ts`, `apps/worker/src/workflows/sandbox-v2.ts` | Independent background custody, permission-checked observe/cancel/output, cleanup demand, bounded inventory and a dedicated Temporal control queue. |
| API coexistence | `apps/api/src/sandbox/engine-route.ts`, `apps/api/src/routes/sessions.ts`, `apps/api/src/sandbox/viewer.ts`, `channel-a.ts` | Read the retained engine before choosing a path; refuse unsupported native interactive access before acquiring a legacy lease or capability. |
| Supporting integration | `packages/tool-gateway/src/index.ts`, `packages/codemode/src/index.ts`, `packages/contracts/src/workspace-integrations.ts` | Accepted request identity and native execution context pass through existing authorization boundaries. |

### What is wired, and what activates it

`runAgentTurn` contains the native branch. Its preparer supports a bounded Linux
contract: authorized HTTPS repository checkout, retained preparation, selected
credentials/variables, finalized file inputs, Skill operations, code search,
ordinary execution and finalization. Bounded image viewing and current-turn
generated-image placement also have implementations. Background tools additionally
require an installed current job-permission owner.

`OPENGENI_SANDBOX_V2_ENABLED` defaults to false. Fresh admission also needs literal
workspace opt-in and a qualified provider policy. Production boot installs no
qualified v2 adapter or admission policy. **Flipping flags alone does not enable
the prototype.** Injectable providers in tests are not production installations.

An existing group's recorded engine remains authoritative when flags change.
Native groups never fall back to legacy leases. Connected Machines retain their
existing route. The migration installs schema; it does not migrate groups, delete
legacy data or make the prototype safe to deploy.

## Provider research

The following public documentation was checked on 6 October 2026. These are vendor
contracts/claims and design implications, not a completed comparative benchmark.
Current prices, resource classes and retention must be rechecked before selection.

| Candidate | Relevant documented behavior | Decision still required |
| --- | --- | --- |
| Sprites | Persistent root filesystem; fixed eight-vCPU envelope; platform-managed memory growth under pressure. Cold wake does not guarantee process continuity. [Lifecycle](https://docs.fly.io/sprites/concepts/lifecycle). | Promising persistent-machine candidate. Qualify actual charged CPU/RAM, billable floors, usable headroom, flush/host-loss behavior and original command recovery across warm/cold states. |
| Modal | CPU/RAM can burst when host capacity exists; billing uses the greater of request and actual use. Filesystem and memory snapshots have different retention. [Resources](https://modal.com/docs/guide/sandbox-resources), [snapshots](https://modal.com/docs/guide/sandbox-snapshots). | Strong resource-model candidate. Determine which exact persistence mechanism can own routine lifecycle, including exit failure, retention and replacement lineage; manual snapshots alone do not settle this. |
| boxd | RAM billed on resident use, disk on written storage; CPU billed on the selected full vCPU count while running. Native standby/hibernation are documented. [FAQ](https://boxd.sh/faq/). | Compare total useful-work cost despite reserved CPU; qualify memory headroom, background progress, host-loss recovery and old-writer retirement. |
| E2B Cloud | Pause retains filesystem and memory; paused sandboxes have indefinite retention. Resource pricing is configuration-based. [Persistence](https://docs.e2b.dev/sandbox/persistence), [pricing](https://e2b.dev/pricing). | Useful pause/resume candidate. Qualify active-memory economics, supported resource growth and the exact runtime class; paused persistence alone does not establish automatic growth. |
| Daytona | Resources are reserved; CPU/RAM can explicitly grow while running. Shrinking CPU/RAM requires stopping first. [Scaling](https://www.daytona.io/docs/en/scale/). | Compare selected runtime classes independently. Explicit live resizing is different from automatic pressure-driven growth; verify disk/process retention and useful-work cost. |
| Freestyle | Allocated CPU/RAM/storage pricing; paused machines release compute reservations. Explicit live resize is documented. [Pricing](https://www.freestyle.sh/docs/vms/pricing-and-limits), [lifecycle](https://www.freestyle.sh/docs/vms/lifecycle). | Qualify resource ceilings, resize semantics, whole-root retention and effective active cost. Explicit resize does not establish automatic ballooning. |

The broader research inventory also includes Blaxel, Vercel Sandbox, Cloudflare
Sandbox/Containers, boat, Tensorlake named sandboxes, Runloop, Deno Sandbox, Hopx,
Morph Cloud Devboxes, AWS Lambda MicroVMs, exe.dev, Northflank, Together Code
Sandbox and the separate legacy CodeSandbox SDK. Keep these candidates open;
marketing terms such as autoscaling, persistent and snapshots must be translated
into the same concrete contracts before eliminating or selecting one.

For every candidate, record CPU and RAM independently: allocated versus measured
billing, floor, ceiling, availability under host pressure, automatic versus
explicit growth, restart requirements, and reclamation after a burst. Also record
full-root versus mounted-directory persistence, memory survival, maximum lifetime,
paused retention, host failure, command identity, unattended progress, region,
images, ingress, cleanup and spending controls. Compare completed workload cost
and failure behavior, rather than an equal nominal VM shape or startup headline.

Self-operated routes considered include Proxmox with shared storage, Incus,
KubeVirt with Kubernetes/CSI, Agent Sandbox with gVisor, E2B Runtime, licensed
boxd, OpenSandbox variants and the local Docker adapter. Prefer an existing
complete platform over adding an OpenGeni scheduler/storage/ingress system.
Placement, concurrent burst headroom, durable whole-root storage, node partitions,
old-writer fencing, isolation, browser compatibility and operating cost all remain
qualification work. A single-daemon Docker adapter does not establish those facts.

No provider is selected or production-qualified by this branch. The next useful
decision is which existing complete platform can satisfy the required contracts
with the least application-owned lifecycle machinery.

## Validation and reproduction

Fixtures use generated identities, reserved example domains and local transports.
They exercise command/lifecycle uncertainty, input/output replay, permission
changes, credentials, background ownership and legacy coexistence. The detailed
design and [journal README](../../agent/crates/opengeni-run/README.md) explain their
boundaries.

Focused checks that require no provider account or model credentials:

```sh
bun --no-env-file test \
  packages/runtime/test/sandbox-v2-machine.test.ts \
  packages/runtime/test/sandbox-v2-machine-session.test.ts \
  packages/runtime/test/sandbox-v2-journal-client.test.ts \
  packages/runtime/test/sandbox-v2-docker-backend.test.ts \
  packages/runtime/test/sandbox-v2-runtime.test.ts \
  packages/runtime/test/turn-invocation-drain.test.ts \
  apps/worker/test/sandbox-v2-turn.test.ts \
  scripts/release-schema-contract.test.ts
bun --no-env-file run check:docs-refs
```

The Linux differential cases require `JOURNAL_CONFORMANCE_IMAGE`; skipped cases
are not a passing native-runtime qualification. Build/run the finite network-off
journal image using its README. PostgreSQL suites require a disposable
pgvector-enabled fixture, configured according to the root `AGENTS.md`. The
Temporal coexistence fixture additionally needs the integration stack.

Read these integration suites before changing the ownership protocol:

- `packages/db/test/migration-0638-sandbox-v2-machines.test.ts` and the
  `sandbox-v2-{admission,commands,preparation}.test.ts` tests.
- `apps/worker/test/sandbox-v2-native-preparation.integration.test.ts` for the
  ordinary worker entry point, synthetic issuer/model, local execution, resource
  delivery, media and background-control composition.
- `apps/api/test/sandbox-v2-api-coexistence.test.ts` for retained routing.
- `test/integration/sandbox-v2-workflow.integration.ts` for Temporal coexistence.

Unit/type checks and synthetic integrations do not establish provider durability,
production credential policy, guest isolation or fleet economics.

## Handoff order and merge gates

1. Review this map, the design and the journal contract. Decide whether the
   provider can remove routine application archive/rotation responsibilities.
2. Reconcile the prototype with current `main` before attempting a merge. This
   branch preserves an older base. Shared runtime, worker, database and release
   contract files have changed upstream. In particular, preserve current-main
   physical-versus-inference writer semantics when integrating the native writer
   predicate. Migration 0638 was mechanically renumbered from 0588 to avoid the
   observed collision; recheck the ledger and validate the merged schema.
3. Qualify one managed provider or existing complete self-operated platform,
   including exact lifecycle dispatch/recovery, real billable units, useful work,
   growth and shrinkage, root retention, process/memory continuity across
   pause/resume, connection recovery, host loss and isolation. Adapt the lifecycle interface
   to that provider's native automatic states rather than forcing false stop/wake
   semantics onto it.
4. Finish rig scripts/images/checks/hooks and remaining resource/manifest kinds;
   install production credential, resource and background/MCP authority owners.
   Cross-attempt unfinished preparation adoption is not implemented.
5. Add independent human terminal/viewer/browser/desktop/port ownership. Agent
   PTY commands already exist, but do not supply these product surfaces.
6. Implement explicit existing-group transfer, verified coexistence and source
   retirement. Keep unresolved commands and physical writer ownership intact.
7. Only after these gates, install qualified admission, verify rollout and remove
   obsolete legacy readers/tables/modules. Measure the resulting simplification.

The branch is a reviewable starting point for that work. Its default-off status
does not make the shared-code changes or maintenance migration merge-ready.
