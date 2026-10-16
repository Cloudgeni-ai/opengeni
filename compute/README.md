# Opengeni compute

Sandboxes that keep their files and running programs and cost almost nothing
while idle. Each sandbox is a Firecracker microVM on a host we run. When
nothing is happening it pauses within seconds, gets a saved copy soon after,
and gives up its memory only when the host needs the room. Using it wakes it.

## Status

Opengeni does not use this yet.

| Piece | State |
| --- | --- |
| Host agent: jailed VMs, durable records, restart recovery, sleep levels, activity-based idle, per-sandbox network, smoke suite | on `feat/compute-lab` |
| Pager process, working-set packs, chunk checksums | reviewed, merging into lab |
| Templates for new sandboxes | in review |
| Ready pool, admission with requests and limits | being built |
| Control plane (placement, moves between hosts, autoscaling), observability, Opengeni integration | planned |

Decisions and their reasons are in [docs/adr](docs/adr/README.md). Numbers
below are observations from our lab runs, with workloads and hosts in
[docs/measurements.md](docs/measurements.md); they are not bounds.

## What we optimize for

1. **Nothing saved is lost.** Copies are deleted only after a newer one has
   passed verification. A sleeping sandbox wakes with its programs intact. A
   sandbox whose VM dies while running boots fresh from its disk: programs
   are lost, files are not. [ADR 10](docs/adr/0010-crash-safety-bar.md) states
   the exact fault model.
2. **Idle is nearly free, use is fast.** Idle means no work is happening, not
   that a timer ran out. Memory goes to whoever needs it.
3. **The agent can restart at any moment** without stopping the sandboxes.
4. **Small and plain.** One agent per host and no cluster services, a pure
   decision core, few dependencies, structure rules checked on every change.
   Less code to review is less code to attack.
5. **Measured, not assumed.** Design choices were tested with real Firecracker
   VMs on cloud hosts, both bare metal and nested.

## The picture

```text
 client: Opengeni, later a scheduler
   │  one JSON request per line on a Unix socket:
   │  create, wake, connect, hold, release, sleep, touch, remove, status
 ┌─▼──────────────────────────────────────────────────────── one host ──┐
 │ compute-host agent (root; its socket is the trust boundary)          │
 │   compute-core decides (pure) ──► steps act (VMs, disks, network)    │
 │   records: one durable, fenced record per sandbox                    │
 │                                                                      │
 │   per sandbox:  jailer ─ Firecracker VM ─ its own cgroup             │
 │                 its own network namespace and firewall               │
 │                 small helpers: a disk holder, a pager while loading  │
 │   images: memory images and disks on local disk                      │
 └──┬───────────────────────────────────────────────────────────────────┘
    │ checksummed, compressed 256 KiB chunks and a working-set pack
 object storage (Google Cloud Storage, or a directory)
```

`connect` is the one way into a sandbox: it wakes the sandbox and turns the
connection into a byte stream to a port inside it. Commands, terminals, file
access and previews all ride on it.

## Sleep levels

A sandbox has two separate properties: where its memory is (its level) and
which saved copies exist (local disk, object storage). A sandbox can still be
Paused in RAM while already having both copies, so ending it later is instant.

| Level | Where memory is | Host RAM | Wake, one sandbox (observed) |
| --- | --- | --- | --- |
| Running | RAM | what the guest has touched | none |
| Paused | RAM, processors stopped | the same | about 10 ms |
| Compressed | compressed RAM (bare metal only) | about 110 MiB | about 0.15 s |
| Saved | local disk | none | about 0.1 s while the image is in the host's file cache |
| Archived | local disk and object storage | none | as Saved |
| Remote | object storage only | none | about 1 s from same-region storage |

A sandbox is **in use** while any of these holds: a caller holds it (an agent
turn), its VM uses a quarter of a processor or moves 4 KiB/s over five
seconds, a stream into it is open, or one of its ports saw recent traffic.
Idle means none of them. Holds should carry a lease the caller renews.

Recommended rules (per sandbox, all optional): pause after 10 s idle; save to
local disk after 30 s while staying paused in RAM; archive after 2 minutes;
compress, then end the VM process, **only under memory pressure**, least
recently used first ([ADR 4](docs/adr/0004-memory-pressure-evicts.md));
delete the local copy after 3 idle days and the memory image after 30 (the
files stay; the next wake boots fresh). Any use wakes the sandbox. `sleep`
asks for a minimum depth once holds allow it; a later wake cancels it.

## Saving and waking

- **A memory image is valid only with the disk it was taken with.** Every save
  produces a self-contained memory image (merged into a reflink copy of the
  previous one, so images never chain). Once the sandbox runs again its disk
  moves on, so the image is marked invalid before the guest resumes
  ([ADR 6](docs/adr/0006-memory-images-and-disks.md)).
- **Copies are replaced, never just deleted.** An older copy goes only after a
  newer one has passed verification. Failed local copies are quarantined (the
  last two are kept). The local copy is evicted only after object storage
  proves it holds exactly the archived copy
  ([ADR 7](docs/adr/0007-never-delete-the-only-good-copy.md)).
- **Integrity:** everything read from object storage is checked against its
  hash. Local images are checked for completeness and structure; their
  content is trusted to the local file system.
- **Waking from object storage is lazy.** The agent fetches the pages the last
  wake touched first (one *pack*), starts the VM, and a userfaultfd pager
  serves every other page as the guest touches it
  ([ADR 8](docs/adr/0008-lazy-wake-with-a-working-set.md)).
- **One memory profile per host** ([ADR 5](docs/adr/0005-host-memory-profiles.md)):
  `bare-metal` uses 4 KiB pages, dirty tracking and in-RAM compression;
  `nested` (a host that is itself a cloud VM) uses 2 MiB huge pages, which
  make wakes far cheaper there but cannot be compressed.

## Surviving restarts

Each VM runs under Firecracker's jailer and does not depend on the agent.
Each sandbox has one durable record, written atomically and compare-and-set
on a generation fence; files on disk never count as evidence on their own.
On start the agent settles every record, then takes each VM back
([ADR 9](docs/adr/0009-vms-outlive-the-agent.md)). On lab today, a VM whose
memory was still loading from object storage is stopped and woken again; with
the pager process (merging) it keeps running. One agent runs per host.

## Network

Every guest has the same address (169.254.0.21), MAC and gateway, so a
restored guest's network configuration is right on any host. Open connections
do not survive a restore; the agent tells the guest so, along with the
correct time. Each sandbox has its own namespace, NAT and firewall: the
internet is allowed; the host, private and link-local ranges (including the
cloud metadata address) and other sandboxes are not. A host marked `trusted`
may let guests reach its local network
([ADR 11](docs/adr/0011-fixed-guest-network.md)).

## New sandboxes

For each shape (processors and memory) the host keeps a template: a guest
booted once, paused and saved. A new sandbox gets a copy-on-write copy of its
disk and shares its memory image, so creating one is a restore, not a boot. A
ready pool will keep clones already restored, so a create is a resume
([ADR 12](docs/adr/0012-templates-and-ready-pool.md)).

## Code map

| Path | What it owns |
| --- | --- |
| `crates/compute-core` | Pure decisions: levels, sleep policy, each sandbox's state machine, memory pressure. No I/O, clock or randomness. |
| `crates/compute-engine` | VM operations (boot, pause, resume, compress, snapshot, restore, stop) behind one trait; Firecracker with its jailer, cgroups. |
| `crates/compute-host` | The agent: API, records, steps, images, archives, network, activity, templates. |
| `crates/compute-pager` | The userfaultfd pager, with a pure, separately tested memory-layout core. |
| `crates/compute-storage` | Content-addressed chunks, manifests and stores. |
| `crates/archcheck` | Structure rules from `ARCHITECTURE.toml`, run as `cargo arch`. |
| `smoke/` | End-to-end scenarios against a real agent, real VMs and a real guest. |
| `lab/` | Measurement scripts used to size the design. Not production code. |
| `docs/` | Decisions and measurements. |

`compute-host` joins the others; `compute-core` and `compute-engine` know
nothing of each other. `cargo arch` keeps every production file under 1,000
code lines, keeps I/O, clocks and randomness out of `compute-core`, and allows
`unsafe` only in a short list of files ([ADR 13](docs/adr/0013-structure-rules.md)).

## Testing

The crates target Linux hosts with KVM.

```sh
cargo test --workspace   # unit, simulation and crash-boundary tests
cargo arch               # structure rules
cargo clippy --workspace --all-targets -- -D warnings   # pedantic is on
```

- `crates/compute-core/tests/simulation.rs` runs 400 seeded random histories
  of 600 events (delays, failures, crashes, removals, memory pressure) against
  a fake engine and checks the core against an independent model after every
  input.
- Record writes are crash-tested at every boundary (staged, renamed, synced).
- Tests with real Firecracker run as root on a host prepared by
  `lab/host-setup.sh`, only when `COMPUTE_TEST_LAB` names it:

  ```sh
  sudo env COMPUTE_TEST_LAB=/lab cargo test --workspace
  sudo env COMPUTE_TEST_LAB=/lab COMPUTE_TEST_PROFILE=nested cargo test -p compute-host --test save_wake
  sudo env COMPUTE_TEST_LAB=/lab COMPUTE_TEST_STORE=gs://bucket/prefix cargo test -p compute-host --test save_wake
  ```

  `save_wake` cycles sandboxes through every level including Compressed and
  Remote. `lab` runs the jailed, networked agent with many sandboxes
  (`COMPUTE_TEST_SANDBOXES=100`) at Running, Paused and Saved, kills the agent
  and checks that every sandbox survives and still wakes in time.
- `smoke/` runs SPACE's E2B-style scenarios through one adapter for our API,
  plus our own: sleep levels, concurrent wakes, holds, and an agent restart
  in the middle ([smoke/README.md](smoke/README.md)).

## Not built yet

- **A control plane**: placement, moving sandboxes between hosts, recovery
  after losing a host, autoscaling ([ADR 15](docs/adr/0015-placement-and-moves-between-hosts.md)).
- **Admission with requests and limits** ([ADR 14](docs/adr/0014-requests-limits-and-admission.md)).
- **Observability** and the **Opengeni integration**.

## Credits

Parts are derived from [SPACE](https://github.com/perplexityai/SPACE)
(Apache-2.0): the archcheck tool, the smoke framework and its E2B-style
scenarios, and ideas in the host agent. [NOTICE](NOTICE) lists exactly what
and how it was changed.
