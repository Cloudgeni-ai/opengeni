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
its cost is below what this method resolves, under ADR 16's 0.1% target.
An earlier run of the same method, before every sample read `memory.stat`
in one pass, measured 0.16% (journal only) and 0.20% (exporting) of a
core above the mean of its baselines (10.20 and 10.23). A profile of that
build (perf at 499 Hz over 120 s, with export on) put 84% of the agent's
samples in system calls reading cgroup and `/proc` files, which the
baseline's per-VM sampling already does; the observability code's own
functions held under 0.1% of its samples. Its added cost was a second
scan of each VM's `memory.stat` for `pgmajfault`, every second, which the
one pass removed.

Exporting held 1.1 MiB more anonymous memory than the mean of the
baselines, within ADR 16's 2 MiB target, and 1.2 MiB more file-backed
pages, the binary's code for HTTP and TLS; counting those, the resident
set grew 2.3 MiB, a little over it. Journaling only held 0.6 MiB more
anonymous memory. Events journaled took 85 KB of log per 240 s, about
30 MB a day at this rate.

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
