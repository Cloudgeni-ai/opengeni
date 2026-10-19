# Comparison benchmark

How we compare Opengeni compute with other sandbox systems on the two things an
agent platform feels: how long until a command answers, and how many
sandboxes a host can bring back to work each second. One client harness
(`lab/compare/`) drives every system the same way. Results are in
`measurements.md`.

## Systems

| System | Path the client uses | Resting states |
| --- | --- | --- |
| Opengeni compute, host agent | The host agent's JSON socket, relayed over TCP to the client VM | running, paused, saved, archived, remote |
| Opengeni compute, front door | The E2B JavaScript SDK 2.56.0 against our E2B-compatible front door | as above |
| Agent Sandbox on GKE | The Kubernetes API for SandboxClaim, Sandbox and Pod Snapshot resources; the sandbox router for commands | running, suspended to a Pod Snapshot |
| E2B cloud | The E2B JavaScript SDK 2.56.0; runs only when `E2B_API_KEY` is set | running, paused |

Agent Sandbox is the Kubernetes SIG project (`agents.x-k8s.io`). On GKE its
sandboxes run under gVisor. Its warm pool keeps pods running and
unclaimed; a claim adopts one. Pod Snapshots save a gVisor pod's memory and
files to Cloud Storage; a suspended sandbox has no pod, and resuming it
starts a new pod from its latest snapshot.

## Operations

Every operation is timed by the client, from the moment it sends the first
request until the first byte of the command's output reaches it. The time
until the command finishes is recorded too. Nothing is subtracted: the
client's own network hops, the control plane and any proxy are part of the
system.

- **Create, cold.** A new sandbox with no ready copy and no template: ours
  boots the guest kernel from the base image, theirs schedules a new pod
  (claim against a warm pool of size zero, the v1beta1 way to ask for no
  pool). Container and disk images are already on the node in both cases,
  so neither pays an image download.
- **Create, from a template.** Ours only: no ready copy, but the shape's
  template exists, so the sandbox restores from it instead of booting.
- **Create, from a warm pool.** A ready sandbox is claimed: ours from the
  ready pool (`--template SHAPE:READY`), theirs through a SandboxClaim on a
  SandboxWarmPool.
- **Activation.** An existing sandbox is used again after being idle, once
  from each resting state. Ours: running, paused, saved, archived and
  remote. Agent Sandbox: running, and resumed from a Pod Snapshot. The
  clock starts at the wake request: for ours the connection that also
  carries the command, for theirs the patch that sets the sandbox running.

Putting a sandbox to rest is not timed as part of an activation. It is
timed on its own, because it decides how fast a host can recycle sandboxes
in the rate test.

## Workload

Each create or activation runs one of two commands:

- `echo`: the fastest a system can answer.
- A small Python program that reads a file the sandbox wrote before it went
  idle and prints it. The client checks the text, so an activation that
  lost the sandbox's files, or woke a different sandbox, fails.

## Latency

For each operation and resting state: a warm-up of five operations that
are discarded, then at least 30 measured operations, one at a time, in each
of three runs. A run is a fresh set of sandboxes, created before its
first sample and removed after its last; the next run starts 5 seconds
later, so what they held is free again. We report p50, p90, p99
and max over all measured operations, and the spread of p50 between runs.

Percentiles use the nearest-rank rule: p99 of 90 samples is the 90th
smallest. Nearest rank never invents a value between two samples, and with
few samples it errs high, which is the safe side for a tail.

## Activations per second

N sandboxes are created and put to rest, each as soon as it is made, so a
host never has to hold all N awake at once. The client then waits two
minutes, so whatever putting them to rest started (writing memory images
out, uploading snapshots) is done, and offers activations as an open-loop
Poisson process conditioned on its count: the warm-up and the measured
window each get exactly the offered rate times their length in arrivals,
at independent uniform times, fixed before the step starts. That is what a
Poisson process looks like given its count, so its bursts and exponential
gaps stay, but every window carries the offered load: an unconditioned
draw of 40 expected arrivals varies by about 6, enough to pass a step on
two-thirds of its load. Each arrival is sent at its time, never before it,
whether or not earlier ones have finished. Each arrival picks a resting
sandbox at random, activates it with
`echo`, then puts it back to rest; it rests again before it can be picked
again. Latency is measured from each arrival's scheduled time, not from
when the client got round to sending it, so a client that falls behind
cannot hide queueing (coordinated omission).

The offered rate steps up a ladder, 60 seconds per step with the first 10
seconds discarded; at rates under 0.8 a second the measured part is
longer, so that it holds 40 arrivals. A step **holds** when every
activation succeeded, every sandbox went back to rest, at least 20 were
measured, and p99 is under 1 second. Every arrival is waited for, so a
system that falls behind shows it in the p99; the completed rate is
reported but not judged. A sandbox that fails to go back to rest, or has
not within five minutes of a step, fails that step and ends the search,
since a later step would run on fewer sandboxes than N.

A first search offers each rate once and, after the first step that does
not hold, halves the gap between the last step that held and the first
that did not, three times. The reported search then offers a fixed ladder
around that limit, each rate three times for the slow states (saved,
remote, Pod Snapshot) and twice for the fast ones, each time with its own
arrivals; a rate holds only if every repeat does.

A resting state whose activation p99 without load is already above
half a second is judged against twice that p99 (the higher of the `echo`
and state p99s), rounded up to the next second, instead of 1 second; the
bound is reported with its result. Its
number then says how many activations a second it sustains without
queueing, not that it is fast. The result is the highest rate that held,
and separately the lowest rate at which any error appeared. If no resting
sandbox is free when an arrival comes, the step is reported as
client-limited and N is raised; it never counts as the system's limit.
Neither does an error the client raises itself, such as running out of
local ports for new connections; the client is tuned and the step rerun.

N is large enough that, at the highest rate tried, a sandbox is picked
about once every 30 seconds, so most of the time between uses is rest.
States that keep a sandbox's memory on the host (running, paused) are the
exception: N is then what one host holds comfortably, the same for both
systems, and sandboxes are picked more often.

We report the sustained rate per host, per host vCPU, and per dollar-hour of
the hosts at on-demand list prices for the region. For GKE the hosts are
the sandbox node pool; the system pool that runs the controller, the router
and Kubernetes add-ons, and the cluster management fee, are shown
separately, since a large cluster spreads them over many sandbox nodes.

## Same conditions

- **Machines.** The same machine type for our host and the GKE sandbox
  nodes. Ours needs nested virtualization on a VM; gVisor does not. Where a
  metal shape is available, ours is also measured there.
- **Place.** One region and zone for everything, and the client on a VM of
  its own in that zone. Object storage (our archived and remote levels,
  their snapshots) is a bucket in the same region.
- **Sandbox shape.** 2 vCPUs and 1 GiB at most, with 0.25 vCPU and 512 MiB
  guaranteed: our `vcpus`, `memory_mib`, `cpu_request_millis` and
  `memory_request_mib`; their container limits and requests.
- **Guest contents.** The same root filesystem: the GKE container image is
  made from our base image's files, plus Agent Sandbox's Python runtime
  server, which is how its router reaches a command. Our guest runs
  commands through its own small exec service.
- **Versions.** Every run records the machine type, kernel, Firecracker,
  host agent revision and flags, GKE version, Agent Sandbox controller and
  router versions, gVisor version and the client's own revision.

## What cannot be made equal

- Isolation differs: a Firecracker microVM per sandbox against a gVisor
  user-space kernel per pod. Both are meant for untrusted code.
- The command paths differ: our exec service is a shell on a vsock port;
  theirs is an HTTP server in the pod behind a router. Each system is
  measured with the path its own client uses.
- Their control plane is Kubernetes: a claim is an API write that a
  controller reconciles, and readiness comes back through a watch. That is
  part of the system as offered, so it is in the numbers.

## Running it

See `lab/compare/README.md`.
