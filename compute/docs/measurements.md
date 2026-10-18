# Measurements

Observations from lab runs, not bounds. Firecracker v1.17.0 under its jailer,
one host agent per host, synthetic data only. Measured on 2026-10-16 at
revision `282fea09e` with the smoke guest's port change (`69e0ed5c9`)
applied; the run records name that build `44b0b6d8c`. Changes after it on
this branch: template builds book every input they copy on disk, a zero
`MemAvailable` reading stays zero, the agent refuses a state filesystem
whose allocation it cannot bound, and tests.

Each sandbox has 1 vCPU and 512 MiB, except in the memory-pressure test.
"First response" is the time from the wake request until a command in the
guest answers; "done" is until that command finishes. "a/b" means p50/p90
across the sandboxes woken together. Each run puts the sandboxes to sleep
and wakes them twice; the numbers are from the second round, after the
working set was learned once. MiB and GiB are binary units.

Workload (the "realistic" set): each sandbox copies a repository, runs its
tests and commits; each wake reads the repository and loads it in Node.

## Hosts

| Host | Machine | Memory profile | Object storage |
| --- | --- | --- | --- |
| Bare metal | GCP z3-highmem-192-highlssd-metal (192 vCPUs), us-central1-a, local NVMe | `bare-metal`: 4 KiB pages, compression | GCS, same region |
| Nested | GCP n2-highmem-32, a VM with nested virtualization, europe-north1-a, local NVMe | `nested`: 2 MiB huge pages | GCS, same region |

The Compressed rows on the nested host use the bare-metal profile, because
huge pages cannot be compressed.

## Waking

| Level | Bare metal, 1 | Bare metal, 100 at once | Nested, 1 | Nested, 100 at once |
| --- | --- | --- | --- | --- |
| Paused | 12 ms (done 97 ms) | 78/121 ms (done 197/238 ms) | 12 ms (done 134 ms) | 145/218 ms (done 769/889 ms) |
| Compressed | 57 ms (done 298 ms) | 168/207 ms (done 629/694 ms) | 154 ms (done 686 ms) | 4.4/4.8 s (done 14.9/15.3 s) |
| Saved | 104 ms (done 303 ms) | 277/385 ms (done 443/536 ms) | 166 ms (done 308 ms) | 1.2/2.0 s (done 1.9/2.5 s) |
| Archived | 127 ms (done 327 ms) | 292/416 ms (done 532/617 ms) | 169 ms (done 309 ms) | 1.2/1.9 s (done 1.8/2.4 s) |
| Remote | 1.4 s (done 1.6 s) | 6.8/9.2 s (done 8.3/9.9 s) | 0.77 s (done 0.91 s) | 17.7/20.7 s (done 18.3/21.0 s) |

- Saved and Archived wake from the local disk, usually from the host's file
  cache.
- Remote first runs a fetch step: it downloads the sandbox's disk and
  device state and its working-set pack (the first 128 MiB of memory the
  guest touched, counted before compression) and prepares them; then the
  pager serves the rest of memory as the guest touches it. One fetch step
  took 1.06 s on bare metal and 0.54 s on the nested host. With 100 at once
  the fetches share the host's network and fetch slots: a fetch step took
  2.6 s on average on bare metal and 5.7 s on the nested host, and wakes
  queued for them. A few uploads met GCS 429 and 503 answers and were
  retried; every sandbox completed.
- Compressed with 100 at once is slow on the nested host because 4 KiB page
  faults are expensive under nesting; such hosts run the nested profile.

Time until 100 sandboxes all reached a level, once their rule allowed it:

| Level | Bare metal | Nested |
| --- | --- | --- |
| Paused | 0.16 s | 0.12 s |
| Compressed | 11.0 s | 16.5 s |
| Saved | 3.8 s | 30.7 s |
| Archived | 86 s | 67 s |
| Remote | 126 s | 116 s |

## Host memory per sandbox

| Level | Bare metal | Nested |
| --- | --- | --- |
| Paused | 269 MiB less available host memory. Its cgroup is charged 690 MiB, because that includes its disk's file cache, which the kernel can reclaim | 303 MiB of huge pages |
| Compressed | 64 MiB resident and 57 MiB compressed; 111 MiB less available | not used (59 MiB and 55 MiB with the bare-metal profile) |
| Saved, Archived, Remote | none | none |

## Agent restart

`kill -9` of the agent with 100 sandboxes, 25 each Running, Paused, Saved in
place (paused in RAM with a saved copy) and Saved:

| | Bare metal | Nested |
| --- | --- | --- |
| Serving again after | 347 ms | 325 ms |
| Sandboxes lost | none | none |
| Host wake wait after restart: Running | 0.5/0.8 ms | 0.6/1.1 ms |
| Paused | 73/87 ms | 45/99 ms |
| Saved in place | 96/127 ms | 76/90 ms |
| Saved | 191/200 ms | 174/214 ms |

The wake rows are the agent's own wait until the sandbox runs again, as
its connect reply reports it. They leave out the guest answering a
command, so they are not comparable with the first-response times above.

With 100 Remote sandboxes, a restart was serving after 478 ms on the nested
host and 643 ms on bare metal, and had settled every record after 510 and
742 ms. One remote wake right after the restart answered in 1.0 s on the
nested host and 4.0 s on bare metal (a single sample each).

## New sandboxes

Create until a first command (reading the id, 16 random bytes and dmesg)
finishes in the new sandbox; 1, then 100 at once.

| Start | Bare metal: 1 / 100 at once | Nested: 1 / 100 at once |
| --- | --- | --- |
| Ready pool (a resume) | 56 ms / 151/214 ms, all in 0.29 s | 54 ms / 582/827 ms, all in 1.0 s |
| Template (a restore) | 197 ms / 1.7/2.1 s, all in 2.2 s | 189 ms / 1.6/2.1 s, all in 2.2 s |
| Cold boot | 1.6 s / 3.5/3.7 s, all in 4.0 s | 1.6 s / 8.4/9.6 s, all in 9.9 s |

Filling a ready pool of 101 took 9.3 s on bare metal and 9.5 s on the nested
host. A template was ready 4.0 to 4.6 s after it was asked for.

## Memory pressure

On bare metal, two held sandboxes run: one with 2 GiB and a 256 MiB
request, filled well above that request, and one within its request.
Other processes then take the host's memory until it is short. The first
sandbox gave its file cache back through its balloon in 1.1 s and kept
running. When the host was made shorter than its balloon could cover, it
was paused and saved in 0.7 s although it was held, and it woke by itself
105 ms after the room came back, with its programs. The sandbox within its
request was never touched.

## Network

100 sandboxes restored from Saved all answered within 3.8 s (bare metal) and
4.6 s (nested). Each then tried every blocked destination: the host, the
cloud metadata address, internal ranges and every other sandbox. All 10,700
attempts per host were refused, unreachable or dropped. A first outbound
connection took 17/18 ms on bare metal and 25/56 ms on the nested host.

## Agent memory

Proportional set size of the agent, in MiB:

| State | Bare metal | Nested |
| --- | --- | --- |
| No sandboxes | 37 | 15 |
| 100 sandboxes running | 151 | 57 |
| 100 Remote sandboxes, 100 s after they got there | 138 | 109 |
| Right after a restart with 100 Remote sandboxes | 101 | 50 |
| 2 s after one remote wake and removing all 100 | 384 | 302 |
| 100 s after that | 95 | 46 |

The bare-metal host has 192 processors, and the agent keeps a worker and
some buffers per processor. With 100 Remote sandboxes most of the rest is
pooled connections to object storage, which close within minutes. After
the restart the run woke one sandbox from object storage and then removed
all 100; the agent held more 2 s later and was back down 100 s later.

Two changes got it here, both found with 10 sandboxes on bare metal. With
glibc's allocator the agent held about 730 MiB after waking them from Saved
and archiving them. heaptrack, attached after the first wake, found only
about 35 MB of what it tracked still allocated (178 MB at its peak): most
of the 730 MiB was freed memory kept in per-thread arenas, made by hundreds
of blocking threads that hash and compress chunks. jemalloc, also used for
the C code the agent links, brought the same run to 123 MiB. And chunks
fetched for remote wakes stayed in a cache (capped at 1 GiB) for the
agent's lifetime; they now expire 60 s after arrival, which took the
agent's memory 100 s after the last remote wake and removal from 279 MiB
to 54 MiB.

## Observability overhead

What [ADR 16](adr/0016-observability.md) costs the agent, measured on
2026-10-17 on an Azure Standard_E32ds_v5 (32 vCPUs, nested, `nested`
memory profile, westeurope) with 1,000 sandboxes of 128 MiB running and
one wake per second. Each phase restarted the agent (the VMs kept
running), let it settle for 90 s and then read its processor time and
memory over 240 s, in the order baseline, observability with events
journaled only, observability exporting to an OpenTelemetry Collector on
the same host, and baseline again. The baseline is the lab branch the
observability work started from. No canary ran.

| Phase | Processor, % of one core | Resident at end | Anonymous at end |
| --- | --- | --- | --- |
| Baseline | 10.33 | 38.3 MiB | 29.5 MiB |
| Journal only | 10.26 | 38.6 MiB | 29.9 MiB |
| Exporting | 10.29 | 40.2 MiB | 30.3 MiB |
| Baseline again | 10.23 | 37.6 MiB | 29.0 MiB |

Processor time with observability is within the baselines' own spread
(0.1% of a core between the two here, 0.14% across both runs below), so
this method does not resolve its cost, and whether it is under ADR 16's
0.1% target is unresolved at this precision. An earlier run of the same
method, on the build before each sample read `memory.stat` in one pass,
measured 0.16% (journal only) and 0.20% (exporting) of a core above the
mean of its baselines (10.20 and 10.23). A profile of that build (perf at
499 Hz over 120 s, with export on) put 84% of the agent's samples in
system calls reading cgroup and `/proc` files, which the baseline's
per-VM sampling already does, and under 0.1% of them in the
observability code's own functions; that bounds those functions, not
the work they add inside shared code. The one addition it pointed to
was a second scan of each VM's `memory.stat` for `pgmajfault`, every
second, which the one pass removed.

Exporting held 1.1 MiB more anonymous memory than the mean of the
baselines, within ADR 16's 2 MiB target, and 1.2 MiB more file-backed
pages, the binary's code for HTTP and TLS; counting those, the resident
set grew 2.3 MiB, a little over it. Journaling only held 0.6 MiB more
anonymous memory. Events journaled took 85 KB of log per 240 s, about
30 MB a day at this rate.

The same method on a GCP n2-highmem-32 (32 vCPUs, Intel Xeon at 2.8 GHz,
nested, `nested` memory profile, europe-west4) with 1,000 sandboxes of
128 MiB running, on the final build:

| Phase | Processor, % of one core | Resident at end | Anonymous at end |
| --- | --- | --- | --- |
| Baseline | 14.46 | 36.1 MiB | 27.5 MiB |
| Journal only | 15.05 | 37.2 MiB | 28.3 MiB |
| Exporting | 14.67 | 39.8 MiB | 29.7 MiB |
| Baseline again | 14.91 | 38.0 MiB | 29.3 MiB |

The baseline itself costs more here, and its two runs differ by 0.45% of
a core, so this host resolves the observability cost even less well:
journaling only measured 0.36% of a core above the mean of the baselines
(above both of them) and exporting 0.01% below it; both differences are
smaller than that spread. Exporting held 1.3 MiB more anonymous memory
than the mean of the baselines and 2.7 MiB more resident memory;
journaling only held about the same as the baselines. The journal grew
85 KB per 240 s, as on Azure.

## Cost per sleeping sandbox

Illustrative estimates of the main resources a sleeping sandbox holds,
priced at GCP us-central1 on-demand list prices for a 730-hour month:
memory $0.004237 per GiB-hour (N2, about $3.09 per GiB-month), local SSD
about $0.08 per GiB-month, GCS standard storage about $0.020 per
GiB-month. A sleeping sandbox runs no guest code; the host's own work for
it (sampling, saves, uploads) is small and not priced here.

Sizes come from the bare-metal run's manifests. The memory image is
512 MiB; its manifest maps 234.5 MiB to chunks (231.5 MiB of distinct
content) and the rest to zeros, and stored compressed it is 59 MiB. On
local disk the image file can take the whole 512 MiB, because zeros the
guest wrote stay allocated. Across a sample of ten sandboxes' disks,
324 MiB stored was common to all ten (mostly the base image), another
6.8 MiB was shared by some of them, and each disk referenced 5.1 to
5.2 MiB stored (47 MiB before compression) beyond the common part; the ten
together came to 348 MiB stored. The working-set pack holds at most
128 MiB of memory before compression; at the image's ratio that is about
33 MiB stored.

| Level | What it holds | About per month |
| --- | --- | --- |
| Paused | 0.26 to 0.30 GiB of RAM | $0.81 to $0.92 |
| Compressed | 0.11 GiB of RAM | $0.34 |
| Saved | its memory image (up to 0.5 GiB) and what it wrote to its disk, on local SSD; the base disk is shared | up to $0.04 plus its writes |
| Remote | its compressed memory image, working-set pack and disk chunks beyond the common part (about 0.1 GiB together) | about $0.002 for this live footprint; older copies until they are collected and a share of the common part come on top |

A running sandbox costs what its memory and processors use.

## Fleet decisions

Phase 3, measured on 2026-10-17 by `compute-fleet`'s budget test
(`FLEET_BUDGET_PRINT=1 cargo test --release -p compute-fleet --test budget
-- --nocapture`), release build on one core of an Apple M4 Pro. The fleet
has 5,000 hosts of 384 GiB in 3 zones and 2 memory-image classes, ready
clones of 8 shapes, and 500,000 sandboxes placed one at a time. Each row
times one decision in the service's memory; a real request adds its store
round trips and the proxy hop on top.

| Decision | Count | p50 | p99 | Max |
| --- | --- | --- | --- | --- |
| Create: place and reserve, fleet filling up | 500,000 | 0.42 µs | 1.0 µs | 58 µs |
| Create: place, 98 % of hosts full | 20,000 | 0.17 µs | 0.46 µs | 8 µs |
| Create: no host has room (every pool walked) | 2,000 | 11 µs | 17 µs | 31 µs |
| Renewal: a host's capacity into the view | 15,000 | 0.50 µs | 0.96 µs | 19 µs |
| Wake: find the owner | 200,000 | 0.21 µs | 0.50 µs | 105 µs |
| Recovery: one pass over every host's renewal count | 200 | 90 µs | 163 µs | 343 µs |
| Host lost: clear its sandboxes (about 100) | 200 | 20 µs | 33 µs | 41 µs |
| Host back: reconcile what it lists (about 100) | 200 | 9 µs | 15 µs | 16 µs |

The test fails if any p99 reaches 1 ms (20 ms in a debug build). The
recovery pass runs every 250 ms, so watching 5,000 hosts takes under 0.1 %
of one core.

The protocol simulation (`tests/protocol.rs`) passed 1,000 seeds of each
of its two runs (`FLEET_SIM_PRINT=1 FLEET_SIM_SEEDS=1000 cargo test
--release -p compute-fleet --test protocol`, 162 s on the same machine):
16 hosts and 600 sandboxes for 600 s with clocks up to 0.05 % off, and 8
hosts and 200 sandboxes for 300 s with clocks up to 1 % off, the most the
lease terms allow. Both run under partitions, lost and late messages,
agent and guard stalls and restarts, suspends, power losses (some for
good), stuck freezes and kills, and leader failovers. Over the 2,000 runs:

| | 16 hosts, 0.05 % | 8 hosts, 1 % |
| --- | --- | --- |
| Hosts given up on and their sandboxes recovered elsewhere | 80,447 | 29,162 |
| Adopts from an archive | 2,884,302 | 963,740 |
| Moves while asleep | 648,641 | 160,051 |
| Writes fenced (a former owner's archive refused) | 9,409 | 5,275 |
| Watchdog reboots (a guard that could not stop its VMs) | 10,962 | 4,719 |
| Suspends | 9,582 | 4,179 |
| Registration answers that arrived after a copy was sent again | 8,824 | 4,614 |
| Hosts that died for good / sandboxes lost with them (never archived) | 3,837 / 673 | 1,666 / 533 |
| Least time a given-up host's VMs had been stopped when the service gave up | 2.13 s | 2.06 s |

The terms leave 1.99 s and 1.87 s to spare at those clock errors (the
term and margin, less the term and watchdog on the slowest host clock);
the simulation counts no time to stop the machine. No sandbox ran on two
hosts or under an older epoch in any run, no pointer's stamp went back,
and every lost sandbox had never been archived and last ran on a host
that died.

Mutation checks: dropping the rule that a not-found answer must come
after the create it might have overtaken runs one sandbox on two hosts at
seed 247, and letting the sleep hook skip the freeze does so at seed 1.
Making every registration copy a new attempt fails the lease's unit test
for a registration answered after copies were sent again, and the
simulation then never sees such an answer count.

## Checkpoints

Measured on 2026-10-17 by `save_wake`'s
`a_checkpoint_of_a_running_guest_brings_it_back_on_another_host` (release
build, real Firecracker, `COMPUTE_TEST_PROFILE=nested`) on one Azure
Standard_D32ds_v5 in norwayeast: 32 vCPUs, 128 GiB, nested virtualization,
the state root on XFS so the disk clone shares every extent. The sandbox has
2 vCPUs and 512 MiB, runs a program holding a sum in memory and has written
files; it is checkpointed every 4 seconds, and a second agent then adopts it
from the store under a later owner epoch.

The pause is the time the guest stood still: from asking Firecracker to
pause until its resume returned (`compute.paused_us`). The step is the whole
checkpoint, including the upload. Five runs:

| Checkpoint | Pause p50 | Pause range | Step p50 |
| --- | --- | --- | --- |
| First: a whole image | 122 ms | 112 to 154 ms | 2.58 s |
| Next: a diff merged into the last image | 131 ms | 112 to 147 ms | 1.54 s |

Merging a diff into the last image used to happen while the guest was
paused, which made the diff's pause about 261 ms, twice the whole image's.
The guest now runs again as soon as the snapshot is written and its disk is
cloned; the merge and the upload run while it works. What is left in the
pause is Firecracker writing the snapshot, the disk's sync and the clone.

In every run the adopting host woke the sandbox from the checkpoint with
its program still running and its sum and files as they were at the
checkpoint (in 933 ms in the run that timed it); what the guest wrote after
it (a file on disk and one in memory) was lost, as it should be, and the
first host's next checkpoint was fenced off and dropped its copy.

## Multi-host fleet on GCP (2026-10-17)

Measured on 2026-10-17 by `compute-control`'s `cloud` tests (release
build) against a fleet deployed by `lab/fleet-gcp.sh` in GCP
europe-west4-a: the fleet service and its Postgres store on one
n2-standard-4, and a managed instance group of n2-standard-8 hosts (8 vCPUs,
32 GiB, nested virtualization, 24 GiB of 2 MiB huge pages for VMs, the
state root on a 250 GB pd-ssd with XFS), starting at 3 and allowed 5. The
service grants 10-second leases, archives go to one GCS bucket, and every
host runs the cut-off guard with a 3-second watchdog. Each test sandbox
runs a beater, a shell loop holding a count in memory and sending it over
UDP 20 times a second to a witness in the test, which records when each
beat arrived and from which host. A program kept across a move or a
restore counts on from where it was; a sandbox running on two hosts at
once would send beats from both.

**Moves.** A 1-vCPU, 512 MiB sandbox was put to sleep down to object
storage and moved twice, through three hosts. Each time the new host woke
it with its file and its beater as they were, and no beat came from the
old host after the first from the new one.

| Move | Sleep and move | Wake and first command | Count |
| --- | --- | --- | --- |
| First | 11.4 s | 1.33 s | 11, then 12 |
| Second | 5.6 s | 3.70 s | 23, then 24 |

**A host cut off from the service.** A firewall rule cut one host off from
the service but not from the witness, 25 seconds after its sandbox
(checkpointed every 10 seconds) started beating. Two runs:

| Run | Last beat from the cut host | First beat from the new host | Gap | Cut host live again |
| --- | --- | --- | --- | --- |
| 1 | 6.69 s after the cut | 20.6 s | 13.9 s | 71 s |
| 2 | 6.71 s after the cut | 20.3 s | 13.6 s | 70 s |

The cut host's VM stopped within its 10-second lease (the guard froze it
once its last renewal ran out), and the sandbox ran elsewhere only some 14
seconds later, from its last checkpoint: it never ran on two hosts at once.
The service reset the cut host's instance before giving up on it, and the
host registered again about 70 seconds after the cut.

**A host that dies.** Three sandboxes, each checkpointed every 15
seconds, were gathered on one host by moves, and after 35 seconds that host
was ended at once (no shutdown, nothing saved). Each came back on another
host from its last checkpoint, its beater counting on from there:

| Sandbox | Back after the kill | Work lost (beats ÷ 20 a second) |
| --- | --- | --- |
| 1 | 69 s | 9.8 s |
| 2 | 76 s | 17.0 s |
| 3 | 85 s | 20.0 s |

What each lost is what it did since the capture of its newest checkpoint
in the store; the test allows a period plus 5 seconds. The period is when
checkpoints are due, not a bound on that loss (ADR 18): the recovery point
is the age of the newest published capture, which each sandbox's status
reports. "Work lost" here counts the beats lost and divides by the
beater's nominal 20 a second. Its shell loop beats a little slower than
that, so the real time lost was somewhat longer; the test now also times
the loss from when the witness received the old host's beats, and checks
the larger of the two. The host was
powered off from inside (`sysrq o`), and GCP went on reporting its instance
as stopping for a while: the service's first fence once the lease had run
out, an instance reset, was refused (`RESOURCE_NOT_READY`), and the next,
12 seconds later, found the instance stopped, which counts as fenced. The
service gave up on the host about a minute after the kill. The test then
woke the three sandboxes one after another with a command each, from object
storage, 7 and 9 seconds apart. A host that is merely cut off is fenced at
once, as the table above shows.

**Scale-out.** Busy 1-vCPU, 2 GiB sandboxes were created every 8 seconds,
37 in all, two more than the 3 starting hosts' 73,216 MiB of free memory
holds. The service asked for a host when spare memory fell below 30 per
cent of the group's; the new host was live 325 seconds in, after 31
creates, and all 37 creates succeeded, on 4 hosts. Until then spare memory
never read below 13,824 MiB, room for six more sandboxes, so the group grew
before it ran out. That run read spare memory only after each create; the
test now reads it every second while the creates go on, and fails if it
falls below one more sandbox's before the new host is live.

**What the runs found.** Two defects showed only on fresh cloud hosts and
are fixed with regression tests:

- At boot systemd had not yet enabled the cpu controller at the cgroup
  root, so the agent could not create its VMs' parent group (ENOENT). It
  now enables the memory and CPU controllers in every group above it.
- A move named its target host's renewal before handing the sandbox off,
  and a hand-off longer than the host's request window made the adopt too
  old to accept. The service now takes the target's renewal at each try,
  and retries a named host that refused a request as expired.

The test setup itself had two faults, fixed in `lab/`: the hosts' lab
filesystem kept the 20 GB size of the image it came from on a 250 GB disk,
so placement saw under 7 GB free; and idle sandboxes slept and gave their
memory back, so the scale-out test now keeps each one busy.

## Admission gaps (2026-10-17)

Measured on 2026-10-17 on branch `feat/compute-gaps`, on one Azure
Standard_D32ds_v5 in swedencentral: 32 vCPUs and 128 GiB, a VM with nested
virtualization, its local temporary disk as XFS for the state root, and
Azure Blob storage in the same region. Host kernel 7.0, guest kernel
6.18.54, Firecracker v1.17.0 under its jailer. The smoke guest image, as in
the gate.

### Huge pages and free page reporting

A 1 vCPU, 2 GiB sandbox on the nested profile; its guest touched 1.5 GiB
and exited, and the host's huge-page pool was read from `/proc/meminfo`:

| VM | Before | Guest holding 1.5 GiB | 2 s after it freed it | 30 s after |
| --- | --- | --- | --- | --- |
| Booted | 182 MiB | 1724 MiB | 1582 MiB | 232 MiB |
| Restored from Saved | 152 MiB | 1522 MiB | | 226 MiB |

Firecracker maps guest memory as private anonymous huge pages in both
cases, so a range the guest reports free frees the whole huge pages inside
it. A balloon of 1500 MiB on the same VM, with the guest's memory full of
tmpfs data and page cache, took the guest's free memory from 868 to 56 MiB
and returned nothing to the pool (1716 MiB before, 1738 MiB after): it gives
back 4 KiB pages, and a huge page is freed only whole.

### Ready sandboxes and their fill booking

Four ready sandboxes of 1 vCPU and 512 MiB, 10 s after they were filled,
next to the non-zero part of their template's memory image (what a fill
books, with 64 MiB more):

| Profile | Template footprint | Each ready sandbox holds |
| --- | --- | --- |
| Bare metal | 131 MiB | 43 MiB |
| Nested | 145 MiB | 149 MiB (huge pages) |

On bare metal a restored guest maps its image and holds only what it
touches; with huge pages the pager fills what the guest touched before the
snapshot, rounded to whole huge pages. Either way a ready sandbox holds
less than footprint plus 64 MiB; nested hosts book fills whole anyway.

### Agent threads

The agent's async workers, blocking threads and concurrent compressions at
four settings, on the nested profile with Azure Blob storage. Each run
created 40 sandboxes of 1 vCPU and 512 MiB, wrote 96 MiB of random data and
92 MiB of text into each one's `/tmp`, put all 40 to sleep at Remote at
once, then woke them all at once and read the text back
(`compute-host bench --count 40 --level remote`). Agent processor time is
the agent process's user and system time over the whole run, so it
includes the creates and wakes; its average is that time over the run's
wall time.

| Workers, blocking, compressions | All 40 at Remote | Each at Remote, p50 | Remote wake, first byte p50 / p90 | Agent processor time | Processors on average | Agent threads at most |
| --- | --- | --- | --- | --- | --- | --- |
| 2, 66, 2 | 238 s | 146 s | 8.7 s / 9.0 s | 549 s | 2.2 | 73 |
| 4, 68, 4 | 152 s | 97 s | 5.0 s / 5.2 s | 576 s | 3.5 | 77 |
| 8, 72, 8 (the default on this host) | 110 s | 71 s | 3.1 s / 3.2 s | 614 s | 5.1 | 87 |
| 32, 512, 512 (the previous default) | 44 s | 33 s | 2.3 s / 2.4 s | 816 s | 15.0 | 561 |

Archiving is processor-bound: hashing and compressing each chunk, so the
number of compressions at once sets how fast sandboxes reach Remote. The
previous default archived 40 sandboxes in a third of the time by taking
half the host's processors from its sandboxes for most of a minute, and
spent a third more processor time doing it. The default keeps the agent
near a sixth of this host while a mass wake still reaches its first byte
in about 3 s. Archiving happens after a sandbox has been idle for minutes,
so a slower archive costs local disk for longer, not a user's wait;
`--compress-threads` raises it on hosts whose archives fall behind.

### Noisy neighbours

What the agent sets to keep sandboxes apart: each VM's cgroup gets
`cpu.weight` 100 per processor requested (`cpu_request_millis`, all its
vCPUs unless set lower), `memory.low` at its memory request and no swap.
It sets no limit on disk or network bandwidth and no processor ceiling
beyond the VM's vCPU count.

One busy sandbox next to one other, on the same host as above with
networking on: a victim of 1 vCPU and 2 GiB measured alone, then again
3 s after an aggressor of 4 vCPUs and 4 GiB started a 45 s load. Each
number is the victim's, higher is better.

| What the aggressor ran | Victim's probe | Alone | Next to the aggressor |
| --- | --- | --- | --- |
| 4 processes spinning | `openssl speed sha256`, 16 KiB blocks | 1454 MB/s | 1448 MB/s |
| 4 processes copying 512 MiB buffers | copying a 512 MiB buffer 8 times in Python | 1.81 GB/s | 1.80 GB/s |
| `fio` random 64 KiB reads and writes, direct, 4 jobs at depth 64 | `fio` 4 KiB random reads, direct, depth 32 | 125,574 IOPS | 122,985 IOPS |
| the same | `fio` 1 MiB sequential writes, direct, depth 16 | 1382 MiB/s | 3819 MiB/s |
| 8 loops downloading a 1 GiB blob from the same region | downloading the same blob | 206 MiB/s | 199 MiB/s |

A single 4-vCPU sandbox cannot saturate this 32-vCPU host's processors or
memory bandwidth, and both sandboxes' disks are files on the host, so a
guest's direct I/O still goes through the host's page cache: the files fit
in it, and the sequential-write numbers vary with the host's writeback, not
with the neighbour. The network loop shared the host's link and lost 3 %.
A sandbox that writes more than the host caches, or saturates the link,
would slow its neighbours, since neither has a per-sandbox limit.

Processors are where neighbours collide first, so the weights were
measured with 16 aggressors of 4 vCPUs each spinning on every vCPU, twice
the host's processors, the host 99 % busy during each probe:

| Victim | Aggressors' request each | Alone | Next to the aggressors | Share of alone |
| --- | --- | --- | --- | --- |
| 4 vCPU, weight 400 | 4000 millis, weight 400 | 5812 MB/s | 2561 MB/s | 44 % |
| 4 vCPU, weight 400 | 1000 millis, weight 100 | 5815 MB/s | 5338 MB/s | 92 % |
| 1 vCPU, weight 100 | 4000 millis, weight 400 | 1456 MB/s | 671 MB/s | 46 % |

With equal requests per vCPU the victim gets close to its weighted share:
400 of 6800 weight is 1.9 of the host's 32 processors, 47 % of its 4 (and
49 % for the 1-vCPU victim). Sandboxes that request less than
their vCPUs give way: against aggressors requesting a quarter of theirs,
the victim kept 92 % of its speed. A processor request is a guarantee
under contention, not a cap, so a sandbox requesting little still runs at
full speed on an idle host.

## Sandbox images (2026-10-17)

Measured on 2026-10-17 at `588e229ff` on branch `feat/compute-e2b`, on one
GCP n2-highmem-32 with nested virtualization in europe-west4-a, `nested`
memory profile. Each sandbox has 1 vCPU and 512 MiB and runs our init and
envd. Images were pulled anonymously from Docker Hub and GHCR.

Building an image:

| Image | Content | Layers | Pull | Unpack | ext4 | Id | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| alpine:3.20 | 23 MB | 1 | 0.96 s | 0.10 s | 0.08 s | 3.3 s | 4.4 s |
| busybox:1.37 | 18 MB | 1 | 0.93 s | 0.07 s | 0.06 s | 3.3 s | 4.4 s |
| ghcr.io/cloudgeni-ai/opengeni-sandbox:0.20.0 | 1.66 GB | 18 | 9.3 s | 16.8 s | 4.5 s | 3.0 s | 34.3 s |

Each file is 6 GiB and sparse. "Id" is the BLAKE3 digest of the whole
file, holes read as zeros, so it costs the same for small and large
images.

From the guest's side:

| Image | Create until envd answers | Wake from Saved until envd answers |
| --- | --- | --- |
| alpine:3.20 | 730 ms | 60 ms |
| busybox:1.37 | 727 ms | 61 ms |
| opengeni-sandbox:0.20.0 | 745 ms | 49 ms |

A create is a cold boot here: these sandboxes had no template. The first
create naming an image the host lacked took 3.1 s, from a store on the
same disk, most of it checking the 6 GiB file against its id.

## The E2B front door (2026-10-17)

Measured on 2026-10-17 with `conformance/e2b/run.sh` at `dd50cbedb` on
branch `feat/compute-e2b`, on the same GCP host as above (`nested`
profile), with the fleet service, its front door on HTTPS and one host
agent all on that host, so there is no network between them. The client
is the unchanged E2B JS SDK 2.56.0. The `base` template is
`opengeni-sandbox:0.20.0` at 2 vCPUs and 1,024 MiB, with a ready pool of
one. All 30 SDK checks, the 10 header-routed ones, the 12 checks of the
E2B client Opengeni uses and the 16 `ecw` smoke scenarios passed.

| What the SDK timed | Median of 5 or one run |
| --- | --- |
| `Sandbox.create` from a ready clone | 14 ms (12 to 17) |
| `Sandbox.create` until its first `commands.run` returns | 80 ms (76 to 88) |
| The run's first create (cause not broken down) | 856 ms |
| `Sandbox.connect` to a running sandbox | 2 ms |
| `sandbox.pause()`, complete when it answers (saved to disk) | 256 ms |
| `Sandbox.connect` resuming a paused sandbox | 68 ms |
| A command to a paused sandbox with auto-resume | 93 ms |
| A command to a sandbox the host saved to disk on its own | 81 ms |

A create answers once envd in the clone has its own environment and
access token, so a create from the pool is the API's own work; the
first command adds a TLS connection and envd's process start. In the
guest, envd used 22.1 MiB of resident memory, and the guest as a whole
144 MiB of its 1,024 MiB (`free`, used). A sandbox left with only a
background command, its stream let go, was paused by the host 44 s later:
ten seconds idle, after the guest stopped counting as busy on processor
or disk.

Building the two images for the run, from the registries, with the
store upload:

| Image | Content | Layers | Pull | Unpack | ext4 | Id or store | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| busybox:1.37 (bash and `user` added) | 18 MB | 1 | 0.95 s | 0.15 s | 0.07 s | 3.7 s | 4.9 s |
| opengeni-sandbox:0.20.0 (`user` added) | 1.66 GB | 18 | 9.8 s | 17.1 s | 4.6 s | 3.0 s | 35.2 s |

## An Opengeni session on the fabric (2026-10-17)

The proof ADR 20 asks for. An Opengeni development stack (API, worker
and web on a laptop in Norway, branch `feat/opengeni-e2b-endpoint` at
`f2c3868a7`) ran with `OPENGENI_SANDBOX_BACKEND=e2b`, a timeout of 900 s,
`OPENGENI_E2B_TIMEOUT_ACTION=pause` and auto-resume, against the fleet
service's E2B front door over HTTPS with a test certificate authority. The
fleet ran on one GCP n2-highmem-32 with nested virtualization in
europe-west4-a (one host agent, `nested` profile, local NVMe), with the
Azurite emulator on the same host as its object storage. The sandbox image
was `ghcr.io/cloudgeni-ai/opengeni-sandbox:0.20.0`, built into a bootable
image by the fabric's OCI image builder; each sandbox had 2 vCPUs and
1 GiB. A hosted model drove the session from two user messages.

| What | Result |
| --- | --- |
| Create (Opengeni's provision step, workspace root included) | 500 ms |
| Commands (`uname -a`, write and read a file under `/workspace`, start `python3 -m http.server 8000` in the background, `curl` it) | all exit 0; the first answered 1.7 s after the create finished, later tool calls took 71 to 111 ms, the commands themselves 62 to 104 ms |
| Preview port: `https://8000-<id>.<domain>/notes/fabric.txt` from the laptop | 200 with the file, 144 to 155 ms |
| Idle during the session | the agent paused it after its idle delay (2.3 ms), saved it locally (diff snapshot, 238 ms) and archived it (18.4 MB uploaded, 5.4 s) while the model was not calling it |
| Timeout | E2B's pause at 900 s asks for at least `saved`; the sandbox was already saved and archived, so the agent only released the paused VM (a `drop` step, 21 ms), leaving it `archived` with its local copy kept as a cache |
| Resume on the next message (Opengeni's provision, `origin: resumed`) | 230 ms seen from the laptop; the restore took 80 ms on the host, from that local copy: memory was served by the pager from local disk (`compute.memory.source` `pager`, not `remote`), so nothing was read from object storage |
| After the resume | the file still read `hello from the fabric`, the same server process (pid 901) still ran and answered; the first command itself took 91 ms, but its output reached Opengeni about 0.9 s after the resume finished (not broken down further) |

So this session exercised every level up to `archived`, but its wake read
only local disk. Waking from object storage, where the pages come from
the archive, is measured in the comparison with Agent Sandbox on GKE
(its Activation and Sustained activations tables, `remote` rows).

The run found two adapter defects, fixed on the Opengeni branch and
described in ADR 20: terminal commands never finished, and the workspace
root of this image was not writable by E2B's default user. Before the
fixes, the first turn hung until the sandbox's timeout and then failed
with "the sandbox is still transitioning". Opengeni has no tool that gives
the model a preview link, so the model could not hand one out; the
address above is the one the adapter's exposed-port lookup returns.

## Comparison with Agent Sandbox on GKE (2026-10-17)

The method is in `benchmark.md`; the harness in `lab/compare/`. Measured on
2026-10-17 in GCP europe-north1-a, every machine an Intel Cascade Lake N2:

- **This fabric:** one n2-standard-16 (16 vCPUs, 64 GiB) with nested
  virtualization, its two local NVMe disks as one XFS for the state root,
  GCS in the same region for the archived and remote levels. Ubuntu 24.04,
  host kernel 7.0, guest kernel 6.18.54, Firecracker v1.17.0 under its
  jailer, the host agent built from `feat/compute-lab` at `2fc5fae85` with
  the nested profile (24576 huge pages of 2 MiB, 48 GiB). Reached through
  its own socket, relayed over one TCP hop to the client.
- **Agent Sandbox on GKE:** a Standard zonal cluster, GKE
  1.36.4-gke.1391002 with the managed Agent Sandbox and Pod Snapshot
  add-ons, containerd 2.2.7, Container-Optimized OS with kernel 6.12.105,
  gVisor (`runsc` google-972768331). Sandboxes on one n2-standard-16 node
  in a gVisor pool; the router (`sandbox-router-go` v1.0.7, two replicas)
  and the add-ons' own pods on one n2-standard-4 system node. Pod
  Snapshots go to a hierarchical-namespace GCS bucket in the region.
  Reached through the Kubernetes API and the router's internal load
  balancer.
- **Client:** an n2-standard-8 in the same zone, Bun 1.4.3.
- **Sandbox:** 2 vCPUs and 1 GiB at most, 0.25 vCPU and 512 MiB
  guaranteed, the same Ubuntu 24.04 files on both. Their warm pool holds
  10 pods; our ready pool 10 copies.

Each latency row is three runs of 30 measured operations after 5 warm-ups,
one at a time with a second between them, timed by the client from its
first request to the first byte of output. "echo" is `echo`; "state" is a
Python program that prints a file the sandbox wrote before it rested, and
the client checks the text. p50/p90/p99 over the 90 samples (60 for Pod
Snapshots: 20 per run); the spread is the p50 of each run.

### New sandboxes

Create until `echo` answers in the new sandbox:

| Start | This fabric | Agent Sandbox |
| --- | --- | --- |
| Cold: no ready copy, no template | 1.25/1.30/1.35 s (a boot) | 2.02/2.93/3.85 s (a new pod) |
| From a template | 141/149/156 ms (a restore) | no such start |
| From a warm pool of 10 | 17/20/35 ms | 236/591/1840 ms |

- Ours from the pool is a resume of a ready VM; theirs is a SandboxClaim
  the controller binds to a running pod (Ready about 230 ms after the
  claim, of which about 20 ms is the API write). Their tail is the API
  server and controller: in 13 of 90 claims the claim took over 500 ms.
- Cold, theirs schedules a pod and starts gVisor and the runtime server
  (images already on the node); ours boots the guest kernel.

### Activation

| Resting state | This fabric, echo | This fabric, state | Agent Sandbox, echo | Agent Sandbox, state |
| --- | --- | --- | --- | --- |
| Running | 7.7/8.0/9.5 ms | 19/21/22 ms | 6.8/8.6/11 ms | 23/27/30 ms |
| Paused | 8.7/9.0/17 ms | 20/22/29 ms | no such state | |
| Saved (local disk) | 82/88/96 ms | 96/107/158 ms | no such state | |
| Archived (local disk and object storage) | 87/157/168 ms | 95/162/179 ms | no such state | |
| Remote (object storage only) | 548/586/747 ms | 541/571/1070 ms | | |
| Suspended to a Pod Snapshot (object storage) | | | 2.08/3.02/3.43 s | 2.15/3.27/3.69 s |

The p50 of each run was within 10 % of the others in every cell (saved
echo 81 to 82 ms, Pod Snapshot echo 2.02 to 2.09 s) except Pod Snapshot
state, 2.04 to 2.49 s.

- A Pod Snapshot is the closest Agent Sandbox state to our remote level:
  nothing of the sandbox is left on the node, and its memory and files
  come back from object storage. Ours answers in 0.55 s there, theirs in
  2.1 s; ours wakes from local disk (saved, archived) in about 85 ms, a
  state Agent Sandbox does not have. Of their 2.1 s, about 25 ms is the
  patch that sets the sandbox running and the rest is until the new pod
  is Ready with an address.
- Running sandboxes answer at the same speed on both: the command path
  (our vsock exec service, their router and HTTP server) costs about
  7 ms. The state program costs 12 ms more on ours and 16 ms more on
  theirs, Python's start under Firecracker and under gVisor.
- Paused is ours alone: the VM is stopped with its memory kept, so it
  costs memory but no processor, and wakes in 9 ms.

### Sustained activations

Open-loop arrivals, each picking a resting sandbox at random, running
`echo` in it and putting it back to rest, as in `benchmark.md`: 60-second
steps with the first 10 seconds discarded and at least 40 measured
arrivals, every window carrying exactly the offered load. A first search
per state found the limit; the reported search then offered a fixed
ladder around it, each rate three times for the slow states and twice for
the fast ones, each time with its own arrivals. A rate holds when every
repeat had no failed activation, every sandbox went back to rest, and p99
from the scheduled time stayed under the bound. One host (theirs: one
sandbox node) does all of it.

| Resting state | N | Bound | Sustained | Worst repeat there, p50/p99 | Next rate up |
| --- | --- | --- | --- | --- | --- |
| Ours, running | 40 | 1 s | at least 300/s | 8.1/16 ms | 500/s client-limited: no errors, p99 21 ms |
| Agent Sandbox, running | 40 | 1 s | at least 500/s | 6.4/14 ms | 1000/s client-limited: no errors, p99 65 ms |
| Ours, paused | 40 | 1 s | 80/s | 8.2/15 ms | 90/s: 8 `host_full` errors |
| Ours, saved (local disk) | 300 | 1 s | 0.8/s | 170/751 ms | 0.9/s: p99 1.07 s in the second repeat |
| Ours, remote (object storage only) | 150 | 3 s | 0.4/s | 643 ms/1.14 s | 0.5/s: p99 3.1 s in the first repeat |
| Agent Sandbox, Pod Snapshot | 60 | 8 s | 0.5/s | 4.6/7.5 s | 0.6/s: p99 8.8 s in the second repeat |

Each held repeat measured 40 to 25,000 arrivals; at 40, p99 is the
slowest of them, so one slow activation fails a repeat.

Per host, per host vCPU and per dollar-hour of on-demand host time
(europe-north1 list prices read from the Cloud Billing catalog on the
day: our host with its two local SSDs and boot disk $0.961 an hour, their
sandbox node with its boot disk $0.886 an hour; their system node and the
zonal cluster fee, $0.329 an hour, are a fixed cost per cluster):

| Resting state | Per host | Per vCPU | Per $1/h of host | Including the cluster's fixed cost |
| --- | --- | --- | --- | --- |
| Ours, paused | 80/s | 5.0/s | 83/s | |
| Ours, saved | 0.8/s | 0.050/s | 0.83/s | |
| Ours, remote | 0.4/s | 0.025/s | 0.42/s | |
| Agent Sandbox, Pod Snapshot | 0.5/s | 0.031/s | 0.56/s | 0.41/s with one sandbox node |

- **Running** is the command path alone, and both systems went past
  what 40 sandboxes let the client offer: a step is client-limited when
  an arrival finds every sandbox busy and nothing failed. At 500/s ours
  had no errors and p50/p99 9.3/21 ms, but 35 of 25,000 arrivals found no
  free sandbox; theirs held twice, at worst 6.4/14 ms. At 1000/s theirs
  had 1,638 such arrivals and p99 65 ms. Both run commands in running
  sandboxes at 300 to 500 a second or more on one host, theirs a few
  milliseconds faster under load. Ours pays one TCP connection per
  request through the lab relay; theirs reuses HTTP connections.
- **Paused** stops at the host agent's disk admission, not at the
  hardware: a running sandbox books room for its next save and for its
  disk to grow (about 9.3 GB here), a paused one only for its save (about
  4.65 GB). When a sandbox pauses, what it no longer books stays booked
  until the agent's next disk reading, once a second, since only a reading
  shows what the VM wrote. Each wake-and-pause therefore holds about
  4.65 GB for up to a second; at 90 a second that, with the 40 sandboxes'
  own bookings, passed the 733 GB the disk had free, though the disk was
  3 % used. The processor was not the limit: p99 was still 15 ms.
- **Saved** is bounded by the local disks. Each activation reads the
  memory image back (about 220 MB with the disk's changed blocks) and the
  rest writes a diff snapshot and merges it (about 160 MB, 360 ms); at
  1/s the NVMe array was a third busy and I/O pressure about 10 %, and
  saves queued behind wakes. The 48 GiB of huge pages in the nested
  profile leave about 13 GB for the page cache, too little to keep 300
  images cached, so every wake reads from disk; a host with fewer huge
  pages would serve repeat wakes from memory.
- **Remote** is the counterpart of a Pod Snapshot: each activation
  fetches the sandbox from object storage, and putting it back to rest
  saves and uploads it again. One host holds 0.4 a second against a 3 s
  bound (twice the state program's unloaded p99 of 1.07 s, rounded up),
  with p50 0.6 to 0.7 s and p99 at most 1.14 s. At 0.5/s 39 of the first
  repeat's 40 activations took at most 1.1 s; one took 3.1 s, of which a
  fetch from object storage was 2.6 s (it is usually 0.5 s), while about
  fifteen re-uploads of other sandboxes were in flight. Because each
  state is judged against its own unloaded p99, ours is held to a bound
  less than half of Pod Snapshot's. An exploratory observation, not
  confirmed with repeats: no remote step we ran, in either search, had a
  p99 over 3.5 s, up to a single window at a nominal 1/s in the first
  search, so against Pod Snapshot's 8 s our remote rate per host may well
  exceed their 0.5/s per node; an equal-bound search was not run.
- **Pod Snapshot** on one sandbox node holds 0.5 restores a second, each
  followed by a new snapshot when the sandbox goes back to rest, with p50
  rising from about 2.7 s at 0.3/s to 4.6 s at 0.5/s. The bound is 8 s, twice
  the state program's unloaded p99 of 3.69 s rounded up.

A first, single-repeat search with unconditioned Poisson arrivals had put
Pod Snapshot at 0.4/s and our saved and remote levels at 0.9 and 0.8/s;
its steps carried from 0.52 to 1.2 times their nominal load by chance,
which the method now rules out.

Caveats: our host is a nested VM, which costs every VM exit; a metal
host was not available in the region (no C3 metal quota). The nested
profile's huge pages are sized for density, not for the saved rate. The
lab host's 256 GB swap file was removed before these runs, which raised
the agent's disk budget. Every rate search first waits two minutes after
putting its N sandboxes to rest, so their writes and uploads are done.
The client widened its local port range for ours (one TCP connection per
request through the lab's relay; in production the socket is local).

## Opengeni end to end on GCP (2026-10-18)

The suite in `compute/e2e` (its README has the steps and checks). Method:
`env.sh up` in project-scoped resources in europe-west4-a: three
n2-standard-8 hosts with nested virtualization in a zonal group that
compute-control grows (hosts have no public address; Cloud NAT), an
n2-standard-32 stack VM (Ubuntu 24.04, kernel 7.0 gcp, 500 GB SSD) running
k3s 1.36 with the Opengeni chart at the compute commit: API, worker (turns
and control), web, relay, Postgres (`max_connections=500`), Temporal, NATS
with auth callout, Garage and `computeControl` (its own schema and role,
two replicas, API over TLS, host endpoint as a NodePort, link signing key,
the team link pointing at the API's agent gateway); Caddy in front with
Let's Encrypt certificates on sslip.io names. Opengeni runs with
`OPENGENI_SANDBOX_BACKEND=compute`, desktop enabled, and the managed
deployment's sandbox rollout controls (turn-owned sandbox leases, lazy
provisioning). The model is an Azure OpenAI deployment made for the runs
(`gpt-5.6-terra`, GlobalStandard). The suite drives sessions through the
public API with real model turns, reads the fabric's own API for host and
sandbox facts, and finishes with a Playwright pass in the web app.

Opengeni's images are built on the stack VM from the development branch of the
backend, merged with the agent's fabric-mode branch; the sandbox images
come from the same checkout, so the agent in each sandbox is the one built
from that commit. Results carry the commits as `backend+agent`.

| run (UTC) | Opengeni | compute | passed | failed | first failure |
| --- | --- | --- | ---: | ---: | --- |
| r1 13:43 | 087c9cb83 | 171ffa83a | 3 | 1 | create: MCP tool startup got HTTP 500; Postgres was at its 100 connections (Temporal holds about 47). Fixed: `postgres.args` in the chart, 500 in the e2e |
| r2 13:46, r3 14:05, r4 14:25 | 087c9cb83, f973bd193 | 171ffa83a, 4dd28c3b3 | 3 | 1 | create: "creating a compute sandbox needs its lease identity". The deployment had sandbox ownership off (the chart's default), so the SDK created the sandbox without the lease; the e2e now sets the managed deployment's rollout controls |
| r5 14:46 | f973bd193+057cd2c06 | fec5f6e4d | 3 | 1 | create: the sandbox was created (17.0 s from the provision start to `sandbox.box.created`, the gateway logged the host linked and the agent's session opened), then the first file write failed: the agent refuses a transfer whose session epoch is 0, which the backend sends |
| r6 14:51 | the same, lazy provisioning off | fec5f6e4d | 3 | 1 | create: the same failure; eager provisioning does not change it |
| r8 15:38 | 1f341facf+e5441d3e1 | 6423207a7 | 10 | 9 | none before create: create (first turn 25.1 s), commands, files, git, browser, move (26.6 s to another host, files kept) pass; see below |
| r9 16:38 | 5ca485cef+734a3ba3a | ab08a672b | 8 | 12 | none before create: create (first turn 25.1 s), commands, files, git, browser pass; see below |
| r10 18:28 | 746756d73+af0b4552f | a89c70f53 | 10 | 11 | none before create: create (first turn 28.2 s), commands, files, git, port, browser, sleep-paused pass; see below |
| r11 20:23 | df78a13f3+af0b4552f | 53fe2cd59 | 13 | 10 | none before create: create (first turn 25.1 s), commands, egress, files, git, port, browser, sleep-paused (verified), move (32.3 s), connected-machine pass; see below |
| r13 21:51 | cf5152969+5faf66b21+6270b6eae | a1972ae1a | 21 | 3 | ui (desktop view too small in the dock; the e2e now maximizes it), delete (409 for 10 minutes; the cleanup row fails with it); every other check passes, the four sleeps verified in the journals; see below |
| r14 22:49 | 130eeb930+ac1951242+6270b6eae | 40a9c32dc | 24 | 0 | none; run-as is n/a (Opengeni cannot ask for it); see below |

Checks after create were skipped through r6 because they need create.
In r8 (every request now carries a nonzero agent epoch) create and most
checks ran. What failed, from the host journals and Opengeni's events:
each sleep level (Paused, Saved, Archived, Remote) completed on the host
within seconds, but the next terminal command through Opengeni did not
wake the sandbox: the host resumed it only about 120 s later, when that
command's timeout fired, so every sleep check and the host-loss check
(which first archives) failed; the interactive terminal answered 409 (no
durable process authority); the desktop's computer session failed to
start (driver failed); a guest port relayed through the front door gave
up after 60 s; and deleting the session stayed at 409 ("still shutting
down") for 15 minutes. The background and desktop checks of r8 were
also too lenient or too strict and were corrected after it (background
commands are listed only while they run; the desktop needs a working
computer session and a screenshot). After the move, the host logged
repeated "more agent-link connections than a sandbox may hold" for the
same sandbox (124 times in 10 minutes). The run-as check
is not applicable: the backend and the agent support running as another
user, but Opengeni has no way to request it for a sandbox.

The port check of r8 and r9 was wrong: it opened `connect/8765`, which
reaches guest vsock port 8765, where nothing listens. A guest TCP port is
reached through the guest's gateway (`connect/57` with the header line
`tcp 8765`); the check does that from r10 on. The move check of r9 failed
because a sandbox is handed off only while it sleeps and the failed
sleep-remote check had left it awake (in r8 it was asleep by chance); the
check now puts it to sleep first.

r9 ran compute-control's versioned schema (`compute_schema`) for the first
time, over r8's database without a reset: both replicas started and all
three hosts registered again. In r9 the background command was listed
while it ran, but stopping it through Opengeni did not end it within
60 s; the terminal, desktop and delete failed as in r8; the UI pass failed
because the session page shows its Files, Terminal and Desktop tabs only
after "Open workspace" (fixed in the pass). The host journal explains
the sleep failures better than r8 did. From 16:39:32 to 16:45:13, right
after the background command started, the host ran the sandbox's
scheduled checkpoint about 110 times a second, each cancelled at once
(76,000 journal lines in six minutes); it stopped when a wake was refused
with "host full: disk, needed 8.1 GB, free 0" while the host's compute
disk had 481 GB free, so the host's disk booking had leaked. Later sleeps
(Saved at 16:47:23, which idle then took to Remote by 16:48:02) were
resumed by a request only at 16:49:24, again about 120 s after the
command that should have woken them.

r10 ran the fabric's fixes for those findings (the wake owed after a
sleep, restore notices ordered by owner epoch, the guest relay closing
fully, and the checkpoint and disk booking fix). In its host journals the
checkpoint loop, the "host full: disk" refusal and the "more agent-link
connections than a sandbox may hold" warning are gone; "guest not told of
its restore ... early eof" appeared once, for an r9 sandbox adopted from
its archive onto a freshly replaced host. The port check passed through
the gateway (2.1 s) and Paused woke in 0.1 s. Saved did not: the host
paused the sandbox and began a save, the suite's command arrived at
once, the host cancelled the save after 5.2 s and resumed the guest, and
the command was never answered (the client gave up after 293 s). The
guest's console shows why: each snapshot of a running guest (every
scheduled checkpoint and every save) drops the agent's control connection
for 0.4 to 1.7 s, and a command in flight then is lost. Ten minutes after
create Opengeni's maintenance revoked the live sandbox's enrollment as
stale (its lease's resume state no longer named the enrollment) and the
orphan sweep deleted the sandbox, so Archived, Remote, the move and the
host-loss check found no sandbox, and the delete stayed at 409 (a stale
browser holder and a direct holder still kept the lease). Stopping the
background command was accepted but nothing settled it; the desktop's
computer session failed in browserd ("interaction controller request
failed"); the API's PTY endpoint now refuses compute by design, so the
terminal check attaches a terminal viewer and speaks its relay PTY as the
web app does (from r10b on). The connected-machine check found the
machine listed as `display_unavailable`, which is how a headless machine
that is online is listed; the check accepts that from r10b on.

Two targeted runs on the r10 deployment followed (`ONLY=`, each under ten
minutes so the enrollment sweep above does not reach the sandbox). In
r10b (terminal, saved, archived, connected-machine) the terminal opened
its relay PTY but got no output: a scheduled checkpoint dropped the
agent's connection and the PTY channel with it. Saved passed only because
the sandbox had not yet gone to sleep when the command arrived, so the
sleep checks now wait for the level to settle before the first command
(2 s Paused, 15 s Saved, 45 s Archived, 60 s Remote), since the fabric
API does not report a sandbox's level. Archived hung as Saved did in r10.
Creating the Connected Machine's session without a first message got
422, so the check now starts the session on the machine with its first
message. In r10c (terminal, desktop, connected-machine) the terminal
passed (the typed command was echoed through the relay PTY) and so did
the Connected Machine: the same agent build enrolled on the stack VM was
online 3.0 s after connecting, ran a session turn and an exec, and still
answered an exec (0.1 s) after 90 s idle, never sleeping. The desktop
failed for a reason outside the fabric: browserd in the guest refused the
computer session with "This interaction runtime does not contain the
experimental CUA SDK". The sandbox images ask for an isolated Linux seat,
for which browserd chooses its CUA backend, and the CUA SDK it loads from
beside its binary is not installed in the images.

Three more targeted runs on that deployment, with the suite as revised
after an independent review (every check now asserts an effect only its
feature produces, and `suite/verify.ts` checks each sleep's level in the
host journals afterwards), changed the picture of the sleeps. In r10d
(19:36) commands (with a failing command's status and output kept),
egress, files and browser passed; browser now needed a browser tool result
carrying the random title of a page served in the sandbox. The background
command was read back by id after it finished, but stopping the long one
left its record `stopping` with no reconcile attempt and its processes
running in the guest, and the session then could not be deleted (409
"Stop this chat's background commands before deleting it"). In r10e
(19:45) paused, saved and archived failed in the verifier: each time the
host resumed the sandbox 1 to 60 ms after it paused it, with cause
`request`, while the suite had sent nothing yet, so the sandbox never
reached the level and the earlier sleep passes (r10's paused among them)
proved nothing. A scheduled checkpoint also dropped the agent's control
connection again. In r10f (19:50, terminal only) the relay accepted the
terminal and the typed input, but no output came back and the guest
console shows no terminal activity; r10c's terminal had passed on the same
deployment.

r11 was the first full run of the revised suite, with the backend's fix
for the stale-enrollment sweep (the sandbox lived through the whole
45-minute run). One of the three freshly rolled hosts did not start:
host setup asked for 13,637 huge pages right after the install had
unpacked the base image and got 12,331, and failed; after reclaiming the
page cache and compacting memory it reserved them all and the host joined.
The journals verify Paused: the sandbox paused at once and stayed paused
until the suite's command resumed it 2 s later. Saved, Archived and Remote
did not happen: each time the host paused the sandbox and took the save
(5.6 to 6.0 s, a diff snapshot), then cancelled it as it finished and
resumed the guest, with cause `request`, while the suite had sent nothing.
The suite's next command then found it running (its 32 MiB process was
intact, but it had never slept). The move's save, a minute after the last
command, did complete (Saved in 6.1 s, archived in 14.2 s, moved in 32.3 s).
For host loss the suite stopped the move's target: the fleet service fenced
it 2.3 minutes later and the sandbox came back on a third host (3.1 GB
fetched in 8.2 s, running 2.5 s later, its agent reconnected to Opengeni at
once, owner epoch 5). It came back from the copy the move had archived,
because the check's own sleep to Remote had been cancelled like the others,
so the file written after the move was missing and the check waited out its
20 minutes; it now fails as soon as the sandbox answers without the file,
and every sleep check waits for the host's own state (`GET
/v1/sandboxes/{id}/state`) to report the level with no step under way, and
holds it 3 s, before it sends the command that wakes it. Stopping the
background command again did nothing: the command ran out its 900 s and
exited on its own at 20:38:40. Deleting the session then stayed at 409
because a browser-session holder of the lease, whose heartbeat had stopped
at 20:25:59, still held it. The terminal failed for a reason in the e2e
environment: the chart's autoscaler keeps two relay replicas, the relay
pairs a stream's two dials in one replica's memory, and the e2e's Caddy
has no channel affinity (which `docs/deployment.md` requires with more
than one replica), so the viewer and the agent met only when both landed on
the same replica; the web app's Terminal tab passed in the same run. From
r12 the e2e runs one relay. The desktop failed as in r10c (the CUA SDK is
not in the images). The Connected Machine passed again, listed online at
every 5 s look through its 90 s idle with the same agent process.

From r13 the e2e runs the chart's default two relays and gives Caddy
(2.11.7) the channel affinity `docs/deployment.md` requires: a headless
Service of the e2e resolves every relay pod and Caddy hashes each dial's
`channel` query, so a stream's two dials meet in one replica. The chart's
own ingress has no setting for that affinity. The fleet checkpoints running
sandboxes every 60 s (`--checkpoint-every-s=60`), so every check runs
across checkpoints, and `FRESH=1` deploys on a new database. r13 (fabric
6eafd93af, where only a request wakes a sandbox) passed 21 checks:

- Terminal through two relays (0.8 s), and the new checkpoint check: a
  viewer terminal printed 150 ticks a second apart and a `terminal/exec`
  command 110 alongside it while the host checkpointed the running sandbox
  three times (journal, 70 s apart); every tick arrived, the terminal was
  never quiet longer than 1.4 s, and the command's longest gap on the
  guest's clock was 2 s.
- All four sleeps, verified in the journals: each level reached (Paused
  0.3 s, Saved 6.6 s, Archived 16.0 s, Remote 19.1 s), no step began
  before the suite's request, and the wake that ended each (resume,
  restore, restore, fetch) was asked for over the agent link
  (`compute.wake.by=agent_link`), 0.03 to 0.07 s after the request. The
  32 MiB process lived through each with the same boot generation; the
  first command answered in 0.1 to 0.5 s, 10.6 s from Remote.
- Move in 35.2 s; host loss came back on another host from the archived
  copy under owner epoch 5 (stopped host fenced, 412 s in all); the
  background command stopped 61 s after the API's stop; the desktop API
  check decoded a 1024x640 frame; the Connected Machine passed.
- The host journals show no agent-link connection limit, no early-EOF
  restore notice, no "host full" refusal and no checkpoint loop; the
  guests' consoles show the agent reconnecting at once twice, one per move
  (move and host loss), not per restore.

The UI's desktop step failed because the dock's width draws the desktop as
a thumbnail; the suite now maximizes the dock first. Deleting the session
stayed at 409 for 10 minutes: the lease still had the agent's browser and
desktop holders (heartbeats stopped at 21:56 and 22:00) and a direct holder
made during the host-loss recovery that kept its heartbeat 8 minutes after
the check ended.

### r14: every check passes

r14 (22:49 to 23:04) ran on three freshly rolled hosts and a new
database (`FRESH=1`), with the backend merged with current main
(130eeb930, whose ancestors are the run-as branch ac1951242 and the agent
fabric branch 6270b6eae) and compute 40a9c32dc (fabric 469570017, with the
pager's permissions fix). Rerun it with:

```sh
. p4.env   # PROJECT, PREFIX, LABELS, the three refs, the Azure account
compute/e2e/env.sh build && compute/e2e/env.sh fleet &&
  FRESH=1 compute/e2e/env.sh deploy && RUN=r14 compute/e2e/env.sh suite
```

Shapes: three n2-standard-8 hosts (nested virtualization, a 26.6 GiB huge-page
pool each), the n2-standard-32 stack VM with two API, two relay and two
compute-control replicas, checkpoints every 60 s. 24 checks passed and
run-as is not applicable; what each proves and how long it took:

| check | what it proves | r14 |
| --- | --- | --- |
| health, hosts, workspace | the API answers; three hosts are live in the fleet | 0.1 s |
| create | a session on the compute backend gets a fabric sandbox and its first model turn runs a shell command in it | 22.1 s to the reply |
| commands | stdout, stderr and a nonzero exit status come back as the guest produced them | 0.3 s |
| egress | the sandbox reaches the internet (HTTPS 200) | 0.4 s |
| background | the agent's background command is read back by id with its output and status; a running one stopped through the API ends and its processes are gone | stopped in 8.7 s (61 s in r13) |
| files, git | write, read and list agree; git works in the workspace | 0.4 s each |
| terminal | a viewer terminal through the relay (two replicas, Caddy channel affinity) runs a typed command whose file appears | 0.8 s |
| checkpoint | a viewer terminal (150 ticks) and a command (110 ticks) stream without a gap across running checkpoints the journal shows | 2 checkpoints, quiet at most 1.7 s |
| port | a guest TCP port answers through the fabric's connect stream | 2.1 s |
| browser | the agent's browser tool loads a page served in the sandbox and returns its random title | 14.7 s |
| desktop | the agent opens a computer session, takes a screenshot, and the API's frame decodes to a real screen | 1024x640, 157 colours |
| ui | Playwright: the web app's file browser, terminal and desktop view | 64.8 s |
| sleep-paused, -saved, -archived, -remote | the host reached the level (state and journal), nothing began to wake it before the suite's request, the request woke it over the agent link, and a 32 MiB process kept its pid and memory under the same boot generation | reached in 0.3, 6.6, 15.2 and 19.0 s; first answer 0.1, 0.5, 0.5 and 8.3 s; each woken by `agent_link` 0.04 to 0.07 s after the request |
| move | a saved sandbox moves to another host and answers there with its files | 29.9 s |
| host-loss | a stopped host's sandbox comes back on another live host under a higher owner epoch, the old host fenced, from the archived copy | back in 280.9 s, owner epoch 3 to 5 |
| delete | deleting the session deletes its fabric sandbox | 25.3 s |
| connected-machine | the same agent build enrolled on the stack VM comes online, runs a turn and an exec, and still answers after 90 s idle with the same process | online in 3.1 s |
| cleanup | the run's sessions are deleted and its enrollment revoked | nothing left |

The saved sleep's paged wake left the pager's `learned.json`, and no
pager logged "Permission denied" (it did once a second before the fabric's
fix). The host journals show no agent-link connection limit, no early-EOF
restore notice, no "host full" refusal, no stream protocol error and no
`madvise` EINVAL. The delete that stayed at 409 in r13 finished in 25 s.
The guest consoles cannot show the reconnects of this run: a VMM writes a
new console at each launch, so the minute copies keep only the last
launch, and the sandbox goes with the delete. From r15 the link-stream and
stale-restore checks count them on the host during the check.
