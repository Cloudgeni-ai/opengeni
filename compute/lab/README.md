# Sandbox sleep and wake lab

Throwaway measurement harness for the sandbox compute design. It answers four
questions on a real cloud host: how much RAM an idle sandbox really needs, how
long each sleep level takes to wake, what happens when many sandboxes wake at
once, and how many sleeping sandboxes fit on one host.

Nothing here is production code. Hosts run only public software and synthetic
workloads.

## Setup

On a Linux host with KVM (bare metal, or a VM with nested virtualization):

```sh
sudo bash host-setup.sh   # Firecracker, a guest kernel, an Ubuntu root filesystem, swap and zswap
```

## Experiments

All scripts run as root with Bun and append JSON lines to `/lab/results/`.

| Script | What it measures |
| --- | --- |
| `exp-reclaim.ts <variant>` | Host RAM held by an idle VM for different guest free-page-reporting settings |
| `exp-single.ts [plain\|devserver]` | One VM: RAM while asleep and time to a finished first command for each sleep level |
| `exp-blob.ts` | Deepest sleep: snapshot and changed disk blocks packed into object storage, then fetched back |
| `exp-fleet.ts <count> [profile] [levels...]` | Many VMs at once: idle CPU, memory per level, and simultaneous wake times |
| `exp-density.ts <count> [L2\|L3] [wakeCount]` | Fills a host with sleeping VMs, then wakes a random subset |

Sleep levels:

- L0: awake and idle.
- L1: paused. The VM keeps its RAM but uses no CPU.
- L2: paused and compressed in host RAM (zswap, no disk writeback).
- L3: paused and swapped to local disk.
- L4: full memory snapshot on local disk; the VM process exits and holds no RAM.
- Blob: the L4 snapshot plus changed disk blocks, compressed in object storage.

`fc.ts` is the small Firecracker driver the scripts share: one cgroup, one
copy-on-write root filesystem and one vsock exec channel per VM.
