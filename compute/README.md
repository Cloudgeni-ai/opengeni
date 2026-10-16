# Opengeni compute

Sandboxes that keep their files and running programs and cost almost nothing
while idle. Each sandbox is a Firecracker microVM on a host we run. When
nothing is happening it pauses within seconds, gets a saved copy soon after,
and gives up its memory only when the host needs the room. Using it wakes it.

## Status

Opengeni does not use this yet.

| Piece | State |
| --- | --- |
| Host agent: jailed VMs, durable records, restart recovery, sleep levels, activity-based idle, per-sandbox network, pager process, working-set packs, chunk checksums, smoke suite | on `feat/compute-lab` |
| Templates for new sandboxes | in review |
| Admission with requests and limits, memory guarantees for running VMs | in review |
| Ready pool | being built |
| Control plane (placement, moves between hosts, autoscaling), observability, Opengeni integration | planned |

Decisions and their reasons are in [docs/adr](docs/adr/README.md). Numbers
below are observations from our lab runs, with workloads and hosts in
[docs/measurements.md](docs/measurements.md); they are not bounds.

## What we optimize for

1. **Nothing saved is lost.** Copies are deleted only after a newer one has
   passed verification. A sandbox with a valid saved memory image wakes with
   its programs intact. One without (it was running, or paused but not yet
   saved, when its VM process died) boots fresh from its disk: programs are
   lost, data the guest had written to its disk is kept.
   [ADR 10](docs/adr/0010-crash-safety-bar.md) states the exact fault model.
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
([ADR 9](docs/adr/0009-vms-outlive-the-agent.md)). A VM whose memory is still
being paged in keeps its pager, a small process of its own, and the restarted
agent reconnects to it. If the pager itself dies, the VM is ended and the
sandbox recovers as [ADR 10](docs/adr/0010-crash-safety-bar.md) says: from a
valid saved image if one exists, else fresh from its disk. One agent runs per
host.

## Host capacity

A host takes on only the memory it can hold. Each sandbox has a memory
request, what it is guaranteed while awake (`memory_request_mib`, all of
`memory_mib` unless set lower), and a limit, its VM size; on huge-page hosts
the request is always the whole VM, since a guest never gives huge pages
back. The requests of awake and waking sandboxes, together with what paused
ones still hold and any use above a request, stay within the host's
capacity (`--memory-capacity-mib`; by default the huge-page pool, or the
host's memory less `--memory-headroom-mib`).

Admission is arithmetic on numbers the agent already holds, decided in
microseconds. Inside a request the only relief is instant: ending idle VMs
whose state is already saved, which frees their memory in milliseconds
without I/O. If that is not enough, the request fails at once with the
retryable `host_full` error, saying how much it needed; it never waits for a
pause, compression or save. Room is made ahead of time instead: the host
keeps `--memory-buffer-mib` (default a sixteenth of the capacity) free by
pushing idle sandboxes deeper in the background, least recently used
first, and also makes room for sandboxes that are held while refused, which
then wake by themselves. Held or recently busy sandboxes are never touched.
When that is not enough on a bare-metal host, sandboxes in use above their
request give way, furthest above first: their balloons take file cache
back from their guests, and if the host is still short one is paused and
saved, held or not, and wakes by itself with its programs once there is
room. A sandbox within its request is never touched. The status shows
`balloon_bytes` and `paused_for_memory` for such sandboxes, and
`waiting_for_room` while one waits.
The status reports the capacity (total, reserved, occupied, free, awake), and
a restarted agent rebuilds it from its records.

The request also sets the VM's guarantees in its cgroup: `memory.low` while
it runs (zero while paused, so the kernel takes from idle VMs first; not
`memory.min`, which would have the kernel kill processes rather than slow a
VM down if the host ever runs short beyond everything unprotected), and
`cpu.weight` from `cpu_request_millis` (all its processors unless set
lower), so contended processors are shared by request while `vcpus` stays
the ceiling. A running VM is never compressed or swapped, not even by the
kernel under memory pressure: `memory.zswap.max` is 0 from launch, on
adoption and before every resume, and opens only while the agent compresses
the paused VM; with `memory.zswap.writeback` at 0 a page zswap refuses is
not swapped out either. The status shows each VM's zswap traffic and memory
pressure. VMMs and pagers have `oom_score_adj` -900, so the host's
out-of-memory killer ends nearly anything else first. On huge-page hosts a
guest that finds the pool empty stalls (its vCPU retries the fault) until a
page is free; admission counting every awake VM whole against the pool
keeps that from happening unless something else takes from the pool.
[ADR 14](docs/adr/0014-requests-limits-and-admission.md) has the reasons.

## Network

Every guest has the same address (169.254.0.21), MAC and gateway, so a
restored guest's network configuration is right on any host. Open connections
do not survive a restore. When the guest runs a notice handler, the agent
tries to tell it so, along with the correct time; a failed notice is logged,
not retried. Each sandbox has its own namespace, NAT and firewall: the
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

## Running a host

`lab/host-setup.sh` prepares a host (Firecracker, kernel, base image, huge
pages on nested hosts). Run the agent as a systemd service of its own, so a
leak in the agent ends only the agent and the VMs keep running while
systemd restarts it:

```ini
[Service]
ExecStart=/usr/local/bin/compute-host --socket /run/compute-host.sock serve \
  --root /var/lib/compute --cgroup /sys/fs/cgroup/compute ...
Restart=always
RestartSec=1
# The agent and its helpers only: room for the 1 GiB chunk cache.
MemoryMax=2G
MemoryMin=256M
```

VMs live in their own cgroups under `--cgroup`, outside the unit's, so its
`MemoryMax` never counts them and stopping the unit never ends them; the
agent refuses to start if `--cgroup` lies inside its own cgroup. The agent
lowers its `oom_score_adj` to -999 at start, below its VMs' -900, so the
host's out-of-memory killer takes VMs before the agent that would bring
them back, yet the agent stays killable inside its own unit.

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

  The engine's `boot_pause_compress_snapshot_restore` covers Paused,
  Compressed and Saved for one VM. `save_wake` cycles guests through Saved and
  Remote, restarts the agent while a guest pages its memory in, and kills a
  pager. `lab` runs the jailed, networked agent with many sandboxes
  (`COMPUTE_TEST_SANDBOXES=100`) at Running, Paused, Saved in place and Saved,
  kills the agent and checks that every sandbox survives and still wakes in
  time; it also fills a host until it answers `host_full` and checks the
  cgroup guarantees. `memory` checks that a busy VM is never compressed
  under host memory pressure (bare metal) and what a guest does when the
  huge-page pool runs out (nested); `squeeze` takes host memory away until
  a busy sandbox above its request gives way through its balloon, then is
  paused, saved and woken again (bare metal).
- `smoke/` runs SPACE's E2B-style scenarios through one adapter for our API,
  plus our own: sleep levels, concurrent wakes, holds, and an agent restart
  in the middle ([smoke/README.md](smoke/README.md)).

## Not built yet

- **A control plane**: placement, moving sandboxes between hosts, recovery
  after losing a host, autoscaling ([ADR 15](docs/adr/0015-placement-and-moves-between-hosts.md)).
- **Observability**: wide events, bounded-cardinality metrics, zero-alarm
  safety counters and a canary per host, exported as OpenTelemetry
  ([ADR 16](docs/adr/0016-observability.md)).
- **The Opengeni integration**.

## Credits

Parts are derived from [SPACE](https://github.com/perplexityai/SPACE)
(Apache-2.0): the archcheck tool, the smoke framework and its E2B-style
scenarios, and ideas in the host agent. [NOTICE](NOTICE) lists exactly what
and how it was changed.
