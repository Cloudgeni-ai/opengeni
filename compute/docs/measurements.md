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

