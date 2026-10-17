# 19. An E2B-compatible front door and our own guest init

Status: Accepted, 2026-10-17

## Context

Clients built for E2B, its SDKs and Opengeni's e2b backend among them,
expect two surfaces: a REST API for sandbox lifecycle, and envd, a daemon
in every sandbox that answers Connect RPC for processes and files and HTTP
for file transfer. Speaking both lets those clients use this fabric
unchanged, and lets us compare it with E2B using the same client code. A
sandbox image should be any OCI image, from any registry, with or without
an init system of its own.

## Decision

- **`compute-control` serves the E2B API that clients use**: create from a
  template (environment, metadata, timeout and what happens at it, internet
  access, public traffic), get, list (by metadata and state), kill, pause,
  resume and connect, set timeout, and listing templates. API keys are sent
  as `X-API-Key`. A sandbox's id is our 32-hex-digit id.
- **E2B's lifecycle words map onto our sleep.** Its timeout is a deadline,
  not a reason to stay awake: when it passes the sandbox is removed, or
  with `onTimeout: pause` put at least as deep as Saved. Meanwhile it
  sleeps whenever idle like any sandbox, and any request or port traffic
  wakes it, so auto-resume is always on. Pause means sleep to Saved;
  resume and connect mean wake.
- **Traffic reaches the guest through the owner host's `connect`.** A
  request names its sandbox and port by host name (`<port>-<id>.<domain>`)
  or by the `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers. The front door
  routes each HTTP request, keeping a small pool of streams per sandbox and
  port. envd's access token passes through; a sandbox created without
  public traffic also needs its traffic token on user ports.
- **Inside the guest, envd from E2B's runtime** (Apache-2.0, built from a
  pinned commit) answers on TCP port 49983, so the protocol is E2B's own,
  not our copy of it.
- **Our own init, `compute-guest`, is PID 1.** A static binary added to
  every image: it mounts the basics, sets up the network from the kernel
  command line, applies restore notices (time, random seed, identity),
  opens the readiness port templates wait for, starts envd, connects
  vsock streams to TCP ports in the guest (so `connect` reaches envd and
  any program listening, on localhost too), reaps orphans and shuts down
  cleanly. It calls envd's `/init` after a create (environment, access
  token, default user and directory) and after a restore (the time).
- **Images from OCI.** The service builds an image from a reference in any
  OCI registry (Docker Hub, GHCR, Google and Azure registries; anonymous or
  with a token): it applies the layers, whiteouts included, into an ext4
  file, adds `compute-guest` and envd, keeps the image's user, directory,
  environment and command, and stores the file in object storage by
  digest. A sandbox's config names its image; a host fetches and caches
  images by digest and keeps templates per image and shape. An E2B
  template id names one of these images.

## Consequences

- Unchanged E2B clients work, and wake transparently: a sandbox that is
  asleep answers its first request after the wake.
- E2B features left out for now: its template build steps, volumes,
  secrets, teams, metrics and logs endpoints, snapshots by id and forks.
- envd is Go and costs a few MiB per guest. Replacing it later with our own
  would change nothing outside the guest.
- A guest's own init system, if it has one, does not run; the image's
  command can be started by `compute-guest` instead.
