# 18. The fleet: one service, leases in Postgres, fences on every write

Status: Accepted, 2026-10-17. Implements [15](0015-placement-and-moves-between-hosts.md).

## Context

[ADR 15](0015-placement-and-moves-between-hosts.md) sets the shape: a
central store, ownership as a fenced lease, moves while a sandbox sleeps,
and no slow work in a request's path. This record fixes the parts, so they
can be built and tested.

## Decision

- **Two crates.** `compute-fleet` is pure, like `compute-core`: placement,
  host leases, sandbox ownership, recovery and moves, as inputs in and
  actions out, with a seeded simulation of thousands of hosts.
  `compute-control` is the service around it: the store, the host API, the
  public API and the proxy to hosts.
- **Postgres is the store.** One database holds hosts (address, zone,
  memory profile, CPU template, lease epoch and state), sandboxes (owner
  key, config, metadata, owner host, owner epoch, latest archive) and API
  keys. Every change is an update conditional on an epoch, so a stale
  writer changes nothing. Postgres gives conditional writes, transactions
  and listing by metadata, and is managed on every cloud. The service keeps
  no state of its own: replicas run behind a load balancer and any of them
  serves any request.
- **Hosts renew their lease through the service.** An agent started with a
  host id and a control address registers, which gives it a host epoch,
  then renews every third of the lease time T (10 s) with its capacity:
  free memory and disk, ready clones per shape, awake sandboxes. A
  renewal is one row update, and capacity changes are sent at most once a
  second. Replicas read changed host rows every 250 ms into a view in
  memory; placement reads only that view.
- **A cut-off host stops its VMs, with or without its agent.** The agent
  writes the lease's deadline to a file in `/run`: the boot clock when it
  sent the renewal, plus T. A guard process, one per host, reads it every
  100 ms and freezes the cgroup that holds every VM once it has passed; a
  renewed lease thaws them. The guard is the agent's own program, started
  by the agent in a cgroup of its own beside the VMs' (not inside it, or it
  would freeze itself, and not in the agent's, so it outlives the agent as
  the VMs do, [9](0009-vms-outlive-the-agent.md)); a restarted agent finds
  it by its lock and starts one only if none runs. The agent also freezes
  them itself when it sees the deadline pass, so both must be gone for a
  VM to run past it. The service hands a host's sandboxes to others only
  once T plus a margin (5 s) has passed since the last renewal it
  accepted, on its own clock, so clocks need not agree, only run at about
  the same rate. A host without a control address has no deadline and
  never freezes.
- **Writes to object storage are fenced too.** Each sandbox has an owner
  epoch, raised whenever it changes hands. The host learns it with the
  sandbox and keeps it in the sandbox's record. Every archive pointer
  carries the epoch of the host that wrote it, and pointers are replaced
  only on condition that they have not changed since read
  ([7](0007-never-delete-the-only-good-copy.md)). A new owner's first act
  is to claim the pointer: it stores it again, unchanged but with its
  epoch, so any archive a former owner began earlier can no longer
  publish. An archive that finds the pointer changed under it reads it
  again before retrying, and one that finds a newer epoch there stops:
  the sandbox belongs to someone else, and the host drops its local copy.
  The agent also starts no archive once its lease's deadline has passed.
  Hosts never delete chunks or manifests (only a sweep does), so a former
  owner cannot take what the new one is waking from.
- **The host API gains `adopt` and `release`.** `adopt` claims the
  sandbox's pointer with the owner epoch the service names and creates a
  record at Remote from what it names, so the next wake fetches it lazily.
  `release` archives a sandbox if its latest state is not archived yet,
  ends its VM and forgets it, keeping the archive. The host API also
  listens on TCP with mutual TLS for the service; the Unix socket stays
  for local tools.
- **Requests.** A create is placed (two random hosts that fit, preferring
  one with a ready clone of the shape, then the most free memory, spread
  over zones) and recorded with owner epoch 1 while the host creates it; a
  host that answers `host_full` sends it to the next candidate. A wake or
  connect goes straight to the owner, found in the replica's cache; an
  answer that the host does not have it refreshes the entry. A sandbox
  with no owner, because its host was lost or it was released, is placed
  like a create and adopted.
- **Recovery.** One replica at a time, holding a Postgres advisory lock,
  watches leases. Once a host's lease is T plus the margin old, it marks
  the host lost (so a late renewal fails and the host must register again),
  raises the owner epoch of each of its sandboxes and clears their owner.
  Each comes back on its next wake, from its latest archive, on another
  host. A sandbox never archived is lost with its host, so the service asks
  for an early archive of every new sandbox. A lost host that comes back
  registers again and lists what it still has; it gets back each sandbox
  nobody has adopted since (its owner still clear, its epoch the one the
  recovery set), with its local state, which is at least as new as the
  archive. It drops the rest.
- **Moves while asleep.** To drain or rebalance a host, the service sends
  `release` for its sleeping sandboxes and clears their owner with a raised
  epoch; the next wake adopts each elsewhere. Live migration stays out of
  scope.
- **Autoscaling.** The leader compares the fleet's spare memory (free
  above each host's buffer, per memory profile) with a target, the larger
  of a fraction of the fleet and room for a few of the largest shapes, and
  sets the host group's size through the cloud's scale-set API (Azure
  virtual machine scale sets, Google managed instance groups). It scales
  in by draining a host before deleting it.
- **Budget.** A wake through the service adds a cache lookup and one proxy
  hop. A create adds placement and one row insert, done while the host
  works. The simulation checks that each placement, renewal and recovery
  decision takes well under a millisecond at 5,000 hosts and 500,000
  sandboxes.

## Consequences

- A service and a database to run. A host without them works as before.
- A host cut off for longer than T has its VMs frozen; their programs are
  lost once their sandboxes are handed elsewhere.
- Losing a host costs what changed since each sandbox's last archive.
- Restoring memory on another host needs the same CPU template across a
  fleet; otherwise the sandbox boots fresh from its files.
- Open connections do not survive a move or a recovery.
