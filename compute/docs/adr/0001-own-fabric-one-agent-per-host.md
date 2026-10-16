# 1. Our own fabric: one agent per host, Firecracker microVMs

Status: Accepted, 2026-10-15

## Context

Agent sandboxes spend most of their life idle, waiting for a person, yet must
keep their files and running programs and come back fast. SPACE, an
open-source Firecracker platform, solves much of this but runs as a set of
Kubernetes services on every host and is a large code base to own.

## Decision

Build our own: one host agent per machine that runs every sandbox as a
Firecracker microVM and exposes a small local API (one JSON request per line
on a Unix socket). `connect` turns a connection into a byte stream to a port
inside the sandbox, and is the single way in for commands, terminals, files
and previews. No cluster services are required. VM operations sit behind one
`Engine` trait. Where SPACE already does something well, copy it with
attribution (see `NOTICE`).

The agent runs as root. Its socket is the trust boundary: whoever can connect
to it controls every sandbox on the host, so only the local control client
may reach it.

## Consequences

- Host overhead is the agent (about 11 MiB) plus per sandbox a jailed VMM
  (about 3 MiB besides guest memory) and small helper processes.
- The code stays small enough to review in full.
- We own the control plane: placement, moves between hosts and autoscaling
  ([15](0015-placement-and-moves-between-hosts.md)).
- Firecracker brings a jailer, snapshots and a small attack surface. Another
  VMM (for example Cloud Hypervisor, which can pass through GPUs) can be added
  behind `Engine`.
- The agent needs only Linux with KVM. It can run on Kubernetes nodes, but
  sandboxes are never Kubernetes pods.
