# 1. Our own fabric: one agent per host, Firecracker microVMs

Status: Accepted, 2026-10-15

## Context

Agent sandboxes spend most of their life idle, waiting for a person, yet
must keep their files and running programs and come back instantly. Hosted
providers charge for that idle time or lose state on sleep. SPACE, an
open-source Firecracker platform, solves much of it but runs as a set of
Kubernetes services on every host and is a large code base to own.

## Decision

Build our own: one host agent per machine that runs every sandbox as a
Firecracker microVM and exposes a small local API (one JSON request per line
on a Unix socket). `connect` turns a connection into a byte stream to a port
inside the sandbox, and is the single way in for commands, terminals, files
and previews. Nothing else runs on the host. VM operations sit behind one
`Engine` trait. Where SPACE already does something well, copy it with
attribution (see `NOTICE`).

## Consequences

- Per-host overhead is the agent (about 11 MiB) plus about 3 MiB of VMM per
  sandbox, besides guest memory.
- The code stays small enough to review in full.
- We own the control plane: placement, moves between hosts and autoscaling
  are ours to build ([15](0015-placement-and-moves-between-hosts.md)).
- Firecracker brings a jailer, snapshots and a small attack surface. Another
  VMM (for example Cloud Hypervisor) can be added behind `Engine`.
- The agent needs only Linux with KVM, so it can run on plain hosts or on
  Kubernetes nodes; neither is required.
