# Opengeni compute

Sandboxes that keep everything (files, running programs, memory) and cost
almost nothing while idle. Each sandbox is a Firecracker microVM on a host we
run. When nothing is happening it pauses within seconds, gets a saved copy
soon after, and gives up its memory only when the host needs the room. Using
it wakes it: from RAM in milliseconds, from disk or object storage in well
under a second.

Status: built and tested on lab hosts, on the `feat/compute-lab` branch.
Opengeni does not use it yet. What is missing is listed under
[Not built yet](#not-built-yet).

## What we optimize for

1. **Nothing is lost.** Sleeping, an agent restart or a bad copy never loses
   a sandbox's data. In a rare crash window a sandbox may roll back to its
   last save; it is never silently corrupted and never left stuck
   ([ADR 10](docs/adr/0010-crash-safety-bar.md)).
2. **Idle is nearly free, use is instant.** Idle means no work is happening,
   not that a timer ran out. Memory goes to whoever needs it.
3. **The agent can restart at any moment.** VMs keep running through agent
   upgrades and crashes, and the agent takes them back when it starts.
4. **Small and plain.** One agent per host and no cluster services on it, a
   pure decision core, few dependencies, and structure rules checked on every
   change. Less code to review is less code to attack.
5. **Measured, not assumed.** Each choice below was measured with real
   Firecracker VMs on cloud hosts, bare metal and nested.

## The picture

```text
 client: Opengeni, later a scheduler
   │  one JSON request per line on a Unix socket:
   │  create, wake, connect, hold, release, sleep, touch, remove, status
 ┌─▼──────────────────────────────────────────────────────── one host ──┐
 │ compute-host agent                                                   │
 │   compute-core decides (pure) ──► steps act (VMs, disks, network)    │
 │   records: one durable, fenced record per sandbox                    │
 │                                                                      │
 │   per sandbox:  jailer ─ Firecracker VM ─ its own cgroup             │
 │                 its own network namespace and firewall               │
 │                 a pager process, only while memory is still loading  │
 │   images: self-contained memory + disk generations on local disk     │
 └──┬───────────────────────────────────────────────────────────────────┘
    │ checksummed, compressed 256 KiB chunks and a working-set pack
 object storage (Google Cloud Storage, or a directory)
```

`connect` is the one way into a sandbox: it wakes the sandbox and turns the
connection into a byte stream to a port inside it. Commands, terminals, file
access and previews all ride on it.

## Sleep levels

| Level | Where memory lives | Host RAM | Wake, one sandbox |
| --- | --- | --- | --- |
| Running | RAM | what the guest has touched | none |
| Paused | RAM, processors stopped | the same | about 10 ms |
| Compressed | compressed RAM (bare metal only) | about 70 to 110 MiB | about 0.15 s |
| Saved | local disk | none | about 0.1 s from the host's page cache |
| Archived | local disk and object storage | none | as Saved |
| Remote | object storage only | none | well under a second, memory loads on demand |

A sandbox is **in use** while any of these holds: a caller holds it (an
agent turn, with a name and a lease the caller renews), its VM uses a
quarter of a processor or moves 4 KiB/s over five seconds, a stream into it
is open, or one of its ports saw recent traffic. Idle means none of them.

The recommended rules (all per sandbox, all optional):

- pause after 10 s idle;
- save to local disk after 30 s, in the background, while it stays paused in RAM;
- archive to object storage after 2 minutes, uploading only changed chunks;
- compress, then end the VM process, **only under memory pressure**, least
  recently used first, between a low and a high watermark of available memory
  ([ADR 4](docs/adr/0004-memory-pressure-evicts.md));
- delete the local copy after 3 idle days, and the memory image after 30
  (files are kept; the next wake boots fresh).

Any use wakes it. An explicit `sleep` pushes it down at once.

## Saving and waking

- **Memory and disk are one unit** with one generation number. They are saved,
  archived and restored together; restoring memory with any other disk would
  corrupt the guest's file system ([ADR 6](docs/adr/0006-self-contained-generations.md)).
- **Every save makes a self-contained image.** Bare-metal hosts write only the
  pages the guest changed; nested hosts write the resident pages. Either way
  the result is merged into a reflink copy of the previous image, so no image
  depends on another. Publishing is write, sync, rename, verify, then move the
  `current` pointer.
- **Never delete the only good copy.** An older copy goes only once a newer one
  has passed verification. A copy that fails is quarantined, not deleted. The
  local copy is evicted only after object storage proves, chunk by chunk
  against recorded checksums, that it holds exactly that copy
  ([ADR 7](docs/adr/0007-never-delete-the-only-good-copy.md)).
- **Waking from object storage is lazy.** The agent fetches the sandbox's
  working set first (the pages its last wake touched first, stored as one
  pack), starts the VM, and a userfaultfd pager serves every other page as the
  guest touches it. The disk is fetched over the host's base image, so only
  chunks that differ move ([ADR 8](docs/adr/0008-lazy-wake-with-a-working-set.md)).
- **Each host has one memory profile** ([ADR 5](docs/adr/0005-host-memory-profiles.md)):
  `bare-metal` uses 4 KiB pages, dirty tracking and in-RAM compression;
  `nested` (a VM inside a cloud VM) uses 2 MiB huge pages, which makes the
  outer hypervisor's work far cheaper but cannot be compressed. Combinations
  that would corrupt data or defeat themselves are refused at start.

## Surviving restarts

- Each VM runs under Firecracker's jailer, as its own user, in a chroot and its
  own cgroup. It does not depend on the agent process.
- Each sandbox has one durable record. It is the only evidence of which files
  are valid; files on disk never count on their own. Every write is
  compare-and-set on a generation fence, so a stale writer can never overwrite
  newer state.
- On start the agent makes sure every record is settled on disk, then takes
  each VM back from its record ([ADR 9](docs/adr/0009-vms-outlive-the-agent.md)).
  Killed with 100 sandboxes at mixed levels, it serves again in about half a
  second and loses none.
- One agent runs per host, guarded by a lock file.

## Network

Every guest has the same address (169.254.0.21), MAC and gateway, so a
snapshot restores on any host with its network intact. Each sandbox has its
own namespace, NAT and firewall: the internet is allowed; the host, private
and link-local ranges (including the cloud metadata address), and other
sandboxes are not. A host marked `trusted` may let guests reach its local
network. The rules are enforced inside the namespace and again on the host
([ADR 11](docs/adr/0011-fixed-guest-network.md)).

## New sandboxes

For each shape (processors and memory) the host keeps a template: a guest
booted once, paused and saved. A new sandbox gets a copy-on-write copy of the
template's disk and shares its memory image, so creating one is a restore,
not a boot. Each clone gets its own identity, which the guest confirms. A
ready pool will keep a few clones already restored, so claiming one just
hands it out ([ADR 12](docs/adr/0012-templates-and-ready-pool.md); templates
are in review, the ready pool is being built).

## Code map

| Path | What it owns |
| --- | --- |
| `crates/compute-core` | Pure decisions: levels, sleep policy, each sandbox's state machine, memory pressure. No I/O, clock or randomness. |
| `crates/compute-engine` | The VM operations (boot, pause, resume, compress, snapshot, restore, stop) behind one trait; Firecracker with its jailer, cgroups. |
| `crates/compute-host` | The agent: API, records, the steps that carry out decisions, images, archives, network, activity, templates. |
| `crates/compute-pager` | The userfaultfd pager, with a pure, separately tested memory-layout core. |
| `crates/compute-storage` | Content-addressed chunks, manifests and stores. |
| `crates/archcheck` | Structure rules from `ARCHITECTURE.toml`, run as `cargo arch`. |
| `smoke/` | End-to-end scenarios against a real agent, real VMs and a real guest. |
| `lab/` | The measurement scripts that sized the design. Not production code. |
| `docs/adr/` | Why things are the way they are. |

`compute-host` joins the others; `compute-core` and `compute-engine` know
nothing of each other. `cargo arch` keeps every production file under 1,000
code lines, keeps I/O, clocks and randomness out of `compute-core`, and allows
`unsafe` only in a short list of files ([ADR 13](docs/adr/0013-structure-rules.md)).

## Testing

The crates target Linux hosts with KVM.

```sh
cargo test --workspace   # unit, simulation and crash-boundary tests
cargo arch               # structure rules
cargo clippy --workspace --all-targets -- -D warnings   # pedantic is on for the workspace
```

- `compute-core/tests/simulation.rs` runs seeded random histories (delays,
  failures, crashes, removals, memory pressure) against a fake engine and
  checks the core against an independent model after every input.
- Record writes are crash-tested at every boundary (staged, renamed, synced).
- Tests that drive real Firecracker run as root on a host prepared by
  `lab/host-setup.sh`, only when `COMPUTE_TEST_LAB` names it:

  ```sh
  sudo env COMPUTE_TEST_LAB=/lab cargo test --workspace
  sudo env COMPUTE_TEST_LAB=/lab COMPUTE_TEST_PROFILE=nested cargo test -p compute-host --test save_wake
  sudo env COMPUTE_TEST_LAB=/lab COMPUTE_TEST_STORE=gs://bucket/prefix cargo test -p compute-host --test save_wake
  ```

  The `lab` test runs the jailed, networked agent with many sandboxes
  (`COMPUTE_TEST_SANDBOXES=100`) through every level, kills it, and checks
  that every sandbox survives and still wakes in time.
- `smoke/` runs SPACE's E2B-style scenarios through one adapter for our API,
  plus our own: every sleep level, concurrent wakes, holds, and an agent
  restart in the middle ([smoke/README.md](smoke/README.md)).

## Not built yet

- **A control plane**: placing sandboxes across hosts, ownership leases between
  hosts, moving a sandbox to another host, and autoscaling
  ([ADR 15](docs/adr/0015-placement-and-moves-between-hosts.md), proposed).
- **Admission with requests and limits**: a full host answers "host full"
  instead of overcommitting busy sandboxes
  ([ADR 14](docs/adr/0014-requests-limits-and-admission.md), in progress).
- **Opengeni integration**: holding a sandbox for an agent turn, and routing
  commands, files and previews through `connect`.

## Credits

Parts are derived from [SPACE](https://github.com/perplexityai/SPACE)
(Apache-2.0): the archcheck tool, the smoke framework and its E2B-style
scenarios, and ideas in the host agent. [NOTICE](NOTICE) lists exactly what
and how it was changed.
