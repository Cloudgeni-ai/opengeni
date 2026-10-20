# Opengeni compute

Sandboxes that keep their files and running programs and cost almost nothing
while idle. Each sandbox is a Firecracker microVM on a host we run. When
nothing is happening it pauses within seconds, gets a saved copy soon after,
and gives up its memory only when the host needs the room. Using it wakes it.

## Status

Opengeni runs on it natively. Opengeni's `compute` sandbox backend, which
lives in Opengeni's runtime and API rather than here
([docs/compute-backend.md](../docs/compute-backend.md)), gives a session a
sandbox microVM that runs Opengeni's own machine agent, reached through its
host agent's one relayed link to Opengeni
([ADR 21](docs/adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md)).
The backend is selected like Modal or Daytona. Opengeni's defaults are
unchanged (Modal in the Helm chart, Docker for local development), and
nothing defaults to compute. The human security review in
[docs/operations.md](docs/operations.md#security) is the remaining
condition before users move off Modal. The E2B front door stays for E2B
clients.

| Piece | What it is |
| --- | --- |
| Host agent | jailed VMs, durable records, restart recovery, sleep levels, activity-based idle, per-sandbox network, pager process, working-set packs, chunk checksums, smoke suite |
| Templates and a ready pool | new sandboxes from a template, or at once from a ready pool |
| Admission | requests and limits, memory guarantees for running VMs |
| Fleet decisions | placement, host leases with a safety budget, the VM guard, fences on every archive write, recovery and moves, with a seeded simulation of the whole protocol |
| A host in a fleet | registering and renewing over mutual TLS, the guard service, owner epochs on every request, adopt, hand-off and reconcile, no decisions while the lease has run out |
| The control service | Postgres store in its own schema, public API and proxy, placement from the capacity hosts push, moves and recovery through object storage, checkpoints of running sandboxes, growing a Google Cloud host group |
| The agent link | each host's one link to Opengeni's agent gateway, carrying every sandbox agent's session, waking a sandbox on a request ([docs/agent-link.md](docs/agent-link.md)) |
| Observability | wide events, bounded metrics, zero alarms, per-sandbox host pressure, a canary, an OTLP exporter |
| Sandbox images | built from OCI images; our init runs each guest and supervises Opengeni's agent, which Opengeni's sandbox image carries, and E2B's envd for the front door |
| E2B front door | E2B's REST API and sandbox traffic, for unchanged E2B clients |
| Packaging | the control service's OCI image in Opengeni's Helm chart (`computeControl`, off by default), a verified host bundle, a Terraform module for GCP hosts, release and CI workflows |
| End to end | an automated suite that runs a full Opengeni stack on a multi-host GCP fleet ([e2e/README.md](e2e/README.md), results in [docs/measurements.md](docs/measurements.md)) |
| Benchmark | activations per second and latency against Kubernetes Agent Sandbox on GKE ([docs/benchmark.md](docs/benchmark.md), `lab/compare/`) |

Decisions and their reasons are in [docs/adr](docs/adr/README.md). Numbers
below are observations from our lab runs, with workloads and hosts in
[docs/measurements.md](docs/measurements.md); they are not bounds. What
an operator must set up and watch is in [docs/operations.md](docs/operations.md).

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
4. **Small and plain.** One agent per host, which needs no cluster services
   to run on its own, a pure decision core, few dependencies, structure
   rules checked on every change. Less code to review is less code to
   attack.
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
| Paused | RAM, processors stopped | the same | about 12 ms |
| Compressed | compressed RAM (bare metal only) | about 110 MiB | about 0.06 s |
| Saved | local disk | none | 0.1 to 0.17 s while the image is in the host's file cache |
| Archived | local disk and object storage | none | as Saved |
| Remote | object storage only | none | about 1 to 1.5 s from same-region storage |

A sandbox is **in use** while any of these holds: a caller holds it (an agent
turn), its VM uses a quarter of a processor or moves 4 KiB/s over five
seconds, a command started through its guest helper still runs (unless
started as fire-and-forget), a stream into it carries traffic (one silent
both ways for 10 minutes stops counting until its next byte, which wakes the
sandbox), or one of its ports saw recent traffic. Idle means none of them. Holds should carry a lease the caller renews.

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
  make wakes far cheaper there but cannot be compressed. The agent picks
  `nested` when the host's CPU reports a hypervisor, unless told otherwise.

## Surviving restarts

Each VM runs under Firecracker's jailer and does not depend on the agent.
Each sandbox has one durable record, written atomically and compare-and-set
on a generation fence; files on disk never count as evidence on their own.
On start the agent settles every record, then takes each VM back
([ADR 9](docs/adr/0009-vms-outlive-the-agent.md)). A VM whose memory is still
being paged in keeps its pager, a small process of its own, and the restarted
agent reconnects to it. The pager runs as its VM's own user, with no
capabilities, and the agent bounds and checks everything it reads from it
([ADR 8](docs/adr/0008-lazy-wake-with-a-working-set.md)). If
the pager itself dies, the VM is ended and the
sandbox recovers as [ADR 10](docs/adr/0010-crash-safety-bar.md) says: from a
valid saved image if one exists, else fresh from its disk. One agent runs per
host.

Streams the agent carries (`connect` to a guest port, so terminals, port
forwards and requests to the guest helper) end with it; clients reconnect.
Guest programs keep running, and the reference guest lets a client read a
command's output from a cursor, to the end of what it wrote, so it
resumes without loss. The guest
helper keeps its list of commands in memory: if the helper itself restarts,
its commands keep running but can no longer be listed, read or waited for.

## Host capacity

A host takes on only the memory it can hold. Each sandbox has a memory
request, what it is guaranteed while awake (`memory_request_mib`, all of
`memory_mib` unless set lower), and a limit, its VM size; on huge-page hosts
the request is always the whole VM: a guest that takes memory back from an
empty huge-page pool stalls until a page is free, so the pool is never
overcommitted (free page reporting does return freed huge pages, but they
stay booked). The requests of awake and waking sandboxes, together with what paused
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
When available memory still runs low on a bare-metal host (below
`--memory-low-mib`, by default a thirty-second of the host's memory and at
least 512 MiB, until twice that is free), idle sandboxes are pushed deeper
and then sandboxes in use above their
request give way, furthest above first: their balloons take file cache
back from their guests, and if the host is still short one is paused and
saved, held or not, and wakes by itself with its programs once there is
room. A sandbox within its request is never touched. The status shows
`balloon_bytes` and `paused_for_memory` for such sandboxes, and
`waiting_for_room` while one waits; asking for it meanwhile gets
`host_full` at once.
Ready sandboxes and template builds are in the same book: each counts
against the capacity like any VM, a fill or build starts only in room above
the buffer and the high watermark that no waiting wake wants, and only
once memory has been read since the agent started, booked before it starts,
and ready sandboxes are the first memory given back, ahead of any
sandbox, for a wake, the buffer or memory pressure. A claimed ready sandbox
moves into the sandbox's place in the same decision. Available memory is
`MemAvailable` plus the free pages on the kernel's per-CPU lists, which it
leaves out (on many-CPU hosts gigabytes for tens of seconds after a process
exits), zero when `MemAvailable` is zero, and on huge-page hosts no more
than the free pool.
The status reports the capacity (total, reserved, occupied, free, awake), and
a restarted agent rebuilds it from its records, counting every VM it takes
back at its full size until it is measured, and any it cannot take back at
its full size until it is removed.

Local disk is booked like memory, since a full disk would block the saves
that relieve memory: every VM whose state is not saved yet books its next
save (its memory once on XFS, where the merge shares extents, otherwise
twice, plus 64 MiB), and bookings plus `--disk-reserve-mib` and
`--disk-reserve-inodes` (default a twentieth of the filesystem) stay within
what is free. A booking stays until a reading after its save shows what
the save used, and nothing needing disk is admitted before the first
reading. Everything else that writes is booked the same way, before it can
write: an awake VM books what its disk may still grow by (its length in
whole allocation units, less what it holds alone, measured every sample;
on XFS and btrfs only blocks no template or base image shares count); a
wake from object storage books its local disk, the memory image its pager
fills and its device state until the image is whole; a new sandbox's
first files and a ready sandbox's fill book their copies before they
start; and a template build books its disk at its full length, its kernel
copy and its snapshot. Each of these that cannot be booked waits or is
refused with `host_full` rather than start. The state filesystem's
allocation unit is learned at start; the state root must be on ext4, XFS
or btrfs, where that unit bounds what any write takes, and the agent
refuses to start on any other filesystem. A wake the disk cannot book gets
`host_full` naming disk or inodes; archived idle sandboxes give up their
local copies in the background to make room. The status shows the disk
(available, booked, reserve, free), and a sandbox's `failed_step` with the
error while a step such as a save keeps failing.

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
cloud metadata address) and other sandboxes are not. A host may list exact
private destinations and TCP ports sandboxes may also open (`--reach`, such
as a private Opengeni's API), and nothing else private opens. Every guest's
name server is its gateway, where the host answers listed names itself and
passes the rest to public name servers, never to the host's own, so guests
learn no private name but those listed
([ADR 11](docs/adr/0011-fixed-guest-network.md)).

## New sandboxes

For each shape (processors and memory) the host keeps a template: a guest
booted once, paused and saved. A new sandbox gets a copy-on-write copy of its
disk and shares its memory image, so creating one is a restore, not a boot. A
ready pool keeps clones already restored and paused, so a create is a resume
([ADR 12](docs/adr/0012-templates-and-ready-pool.md)). Any create of a clone's
processors and memory takes it, whatever it requests: the clone's VM is given
the request's `memory.low` and `cpu.weight` before the claim is recorded. A
clone is used only once its guest has taken its own id, random seed, machine
id and hostname. A fill books its template's memory footprint and its disk
copy until it is ready and measured. A shape unused for a week gives up its
template and ready clones until its next create.

A create may name a sandbox image: any OCI image, built into an ext4 file
with our init and E2B's envd added, and named by the BLAKE3 digest of the
file ([guest/README.md](guest/README.md)). A host fetches an image from its
store the first time a create names it, once however many creates wait,
booking the disk the fetch may take first, and keeps it under
`<root>/rootfs/`. Templates and ready clones are per image and shape. An
image no create used for as long as a template may go unused, and whose
template is gone, is removed. A create without an image uses the host's
base image, as before.

## The fleet

`compute-control` is the control service ([ADR 15](docs/adr/0015-placement-and-moves-between-hosts.md),
[ADR 18](docs/adr/0018-the-control-service-leases-and-fences.md)). Its
Postgres store holds each sandbox's configuration, lifecycle and owner:
the host that owns it and the sandbox's owner epoch, raised each time it
changes hands or loses its owner. Its archives, and the pointer to the
latest one, are in object storage. The service is the hosts' certificate
authority, and issues each host a certificate for the name it proves (on
GCP with its instance identity token). Hosts register over mutual TLS, renew a
lease and push their capacity; creates and wakes are placed from that
capacity, and the public API reaches a sandbox through its owner. A host
runs only what its current lease covers: its guard stops its VMs when
renewals stop, before the service may let another host run them, and every
archive write carries the owner epoch, so a cut-off host cannot overwrite
what the new owner stored. Replicas keep no state of their own; one at a
time leads, gives up on hosts whose renewals stopped and grows the host
group.

A sandbox moves between hosts while it sleeps, through object storage, and
a lost host's sandboxes come back on others from their newest stored copy.
A move hands the sandbox off whole, memory and all; after a host loss the
new host boots it from that copy's files, as after a crash, because the
lost host may have run its programs on past the copy (ADR 18).
A running sandbox is checkpointed to object storage too: by default once it
has run ten minutes since its last stored copy (`checkpoint_every_ms` in
its sleep rules). That period is a scheduling target, not a bound on loss:
a checkpoint may wait for disk admission or retries, and it protects the
sandbox only once it is published. Losing its host costs a sandbox what it
wrote to its files since the capture of its newest published copy, which
its status reports as `backed_up_ms`, and its running programs. Only a
host whose files share extents (XFS,
btrfs) takes checkpoints; on any other its status says so, and its
sandboxes reach the store only as they sleep. With `--gcp-group` the
leader grows a Google Cloud managed instance group before spare memory runs
out (`--scale-spare-per-mille`, `--scale-spare-largest`).

## The E2B front door

`compute-control` can also serve E2B's API, so clients built for E2B use
Opengeni compute unchanged ([ADR 19](docs/adr/0019-e2b-compatible-front-door-and-guest-init.md)).
The baseline is the E2B JS SDK 2.56.0. One listener (`--e2b-listen`,
`--e2b-domain`) answers the REST API (create from a template, get, list,
connect, pause, kill, set the timeout, list templates) and traffic to
`<port>-<id>.<domain>`, or to one address with the `E2b-Sandbox-Id` and
`E2b-Sandbox-Port` headers. Templates name an image and a shape
(`--e2b-template base=<image>:2x1024`). With `--e2b-tls-cert` and
`--e2b-tls-key` it serves HTTPS itself, with one certificate for the API's
name and `*.<domain>`; without them it speaks plain HTTP behind a load
balancer that terminates TLS.

E2B's pause and timeout are lifecycle states the service records, apart
from our own idle sleep: a paused sandbox is saved to disk and wakes only
on connect, or on traffic if it was created with auto-resume. An open
command or PTY stream keeps a sandbox awake; heartbeats on it move neither
its timeout nor anything else. What Opengeni's e2b backend uses works:
create with environment, metadata, timeout, internet access, public
traffic and pause-or-kill at the timeout with auto-resume; connect;
commands in the foreground and background; PTYs with input and kill;
files read, write, make directory and remove; `getHost`; pause; kill.
Left out: snapshots (the backend's optional native snapshot persistence),
volumes, MCP, IAM, egress rules, sandboxes without internet access,
template builds, metrics and logs. A create asking for those is refused.

## Code map

| Path | What it owns |
| --- | --- |
| `crates/compute-core` | Pure decisions: levels, sleep policy, each sandbox's state machine, memory pressure. No I/O, clock or randomness. |
| `crates/compute-engine` | VM operations (boot, pause, resume, compress, snapshot, restore, stop) behind one trait; Firecracker with its jailer, cgroups. |
| `crates/compute-host` | The agent: API, records, steps, images, archives, network, activity, templates, and a host's part in a fleet (lease, guard, listener). |
| `crates/compute-host/src/observe` | What the agent reports: wide events, metrics, the canary and the OTLP/HTTP exporter ([ADR 16](docs/adr/0016-observability.md)). |
| `crates/compute-guest` | The guest's init (PID 1): mounts, network, hostname, envd kept running, the image's command, clean shutdown, and the host's vsock ports. |
| `crates/compute-image` | Turns an OCI image into a sandbox image: pull, checked layers, our init and envd added, an ext4 file. Run as `compute-host build-image`. |
| `crates/compute-control` | The control service: its store, public API and proxy, the hosts' API, placement, moves and recovery, the leader and the host group. |
| `crates/compute-control/src/e2b` | The E2B front door: REST API, lifecycle states and their sweeper, traffic routing with kept streams and holds, TLS. |
| `guest/` | Builds the guest's files: compute-guest, envd from a pinned E2B commit, and a static bash. |
| `crates/compute-pager` | The userfaultfd pager, with a pure, separately tested memory-layout core. |
| `crates/compute-storage` | Content-addressed chunks, manifests and stores; archive pointers stamped with their owner. |
| `crates/compute-fleet` | Pure fleet decisions: placement, host leases, the guard that stops a cut-off host's VMs, the fence rule for archive writes, recovery and moves. No I/O, clock or randomness. |
| `crates/compute-protocol` | The wire forms: the host agent's API and the control service's host API. |
| `crates/archcheck` | Structure rules from `ARCHITECTURE.toml`, run as `cargo arch`. |
| `smoke/` | End-to-end scenarios against a real agent, real VMs and a real guest. |
| `lab/` | Measurement scripts used to size the design. Not production code. |
| `docs/` | Decisions, measurements and operations. |

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
# Ahead of other services when processors are contended.
CPUWeight=1000
```

VMs live in their own cgroups under `--cgroup`, outside the unit's, so its
`MemoryMax` never counts them and stopping the unit never ends them; the
agent refuses to start if `--cgroup` lies inside its own cgroup. Make
`--cgroup` a top-level group: processors are shared between siblings, so
all VMs together then compete with `system.slice` as one group however
busy they are, and a VM's memory protection reaches only as far as its
ancestors' (the agent keeps the parent's `memory.low` at the sum of its
VMs'). The agent lowers its `oom_score_adj` to -999 at start, below its
VMs' -900, so the host's out-of-memory killer takes VMs before the agent
that would bring them back, yet the agent stays killable inside its own
unit. A host that compresses paused VMs needs zswap on; the agent refuses
to start otherwise.

## Observing a host

Every step, request and stream writes one wide event to the agent's log,
and with `--otlp-endpoint` the agent sends events and metrics to an
OpenTelemetry collector over OTLP/HTTP with JSON encoding. Metrics never
carry a sandbox id. Six alarm counters must stay at zero; each occurrence
also writes an event naming the sandbox. `--canary-every` runs a canary
that wakes a small sandbox of the host's own through every path. What to
alert on is in [docs/operations.md](docs/operations.md#observing).

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
- `crates/compute-fleet/tests/protocol.rs` runs the whole fleet protocol,
  seeded, with the crate's own decisions under clock drift, partitions,
  lost and late messages, stalls, restarts, suspends, power losses and
  leader failovers, and checks that no sandbox ever runs on two hosts
  (`FLEET_SIM_SEEDS` sets how many seeds; it runs on any platform).
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
  paused, saved and woken again (bare metal); `disk` fills a small
  filesystem until wakes are refused for disk and checks that a save it
  cannot hold shows in the status and succeeds once there is room.
- The guest tests boot real sandbox images with envd. They need the guest's
  files from `guest/build.sh` and network access to registries:

  ```sh
  OUT=/lab/guest guest/build.sh
  sudo env COMPUTE_TEST_LAB=/lab COMPUTE_TEST_GUEST=/lab/guest COMPUTE_TEST_PROFILE=nested \
    cargo test --release -p compute-host --test guest -- --test-threads 1
  ```

  They build alpine, busybox and the Opengeni sandbox image, run commands
  and move files through envd, sleep and wake a sandbox and find its files
  and environment again, fetch an image from a store once for many creates
  with its own template, give each sandbox cloned from a template its own
  environment and token, run the image's command as its user, and shut the
  guest down cleanly. `COMPUTE_TEST_REQUIRE=lab,guest` makes them fail,
  not skip, when either is missing.
- `smoke/` runs SPACE's E2B-style scenarios through one adapter for our API,
  plus our own: sleep levels, concurrent wakes, holds, and an agent restart
  in the middle, with output read on by cursor and live streams ending
  ([smoke/README.md](smoke/README.md)).
- `conformance/e2b/run.sh` starts a fleet on one lab host (the service with
  its E2B front door serving HTTPS, a host agent with its guard, object
  storage) with the public sandbox image and a minimal image without bash,
  and runs against the front door: the unchanged E2B JS SDK 2.56.0, the
  E2B client Opengeni's e2b backend uses, with that backend's options, and
  the smoke scenarios with `COMPUTE_SMOKE_TARGET=e2b`. It records the
  SDK's create, first command, connect and resume times and envd's memory.

## Not built yet

- **Moving a running sandbox.** Sandboxes move between hosts only while they
  sleep; a live move would copy memory while the guest runs.
- **Releasing a paused sandbox's disk booking at once.** A running sandbox
  books room for its disk to grow, and a pause gives that room back only at
  the host's next disk sample, once a second. That stops one host near 80
  wakes and pauses a second, with its disk nearly empty
  ([docs/measurements.md](docs/measurements.md), the comparison's sustained
  activations).
- **More than one region**: placement across regions, and a control service
  in more than one.
- **E2B's other features**: what the front door leaves out, listed above.
- **A benchmark through the front door**, and against E2B's own cloud.

## Credits

Parts are derived from [SPACE](https://github.com/perplexityai/SPACE)
(Apache-2.0): the archcheck tool, the smoke framework and its E2B-style
scenarios, and ideas in the host agent. [NOTICE](NOTICE) lists exactly what
and how it was changed.
