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
  as `X-API-Key`. A sandbox's id is our 32-hex-digit id. The baseline is
  pinned: the E2B JS SDK 2.56.0, which uses `/v2/sandboxes` and
  `/v2/sandboxes/{id}/connect`, sends `autoPause`, and reads `envdVersion`,
  `domain` and the access tokens from the answers, and envd from a pinned
  commit of E2B's runtime. A conformance suite runs that SDK unchanged:
  lifecycle, streaming commands, PTYs and signed file transfer. It also
  runs the E2B client Opengeni's e2b backend uses, built with that
  backend's options, and SPACE's E2B-style smoke scenarios, all through
  the front door.
- **What a create may not ask for is refused, not ignored**: MCP, IAM,
  volume mounts, `allow_internet_access: false`, egress rules or an egress
  proxy, `maskRequestHost`, and `autoPauseMemory: false`. A create asking
  for any of them gets a 400 naming them. `autoResume` needs `autoPause`.
- **E2B's lifecycle words map onto our sleep, with explicit states.** A
  sandbox E2B calls running sleeps whenever idle like any other, and any
  request or port traffic wakes it; that is our own business and not
  visible through the API. E2B's pause, and its timeout, are different:
  the service records them as lifecycle states (`pausing`, `paused`,
  `killing`), which traffic does not cancel. Pausing ends every command and
  PTY stream, saves to at least Saved, and is complete only when the host
  confirms the save; until then the sandbox is `pausing` and refuses new
  work. A paused sandbox wakes on resume or connect, and on traffic only
  if it was created with auto-resume; otherwise traffic gets E2B's answer
  for a paused sandbox. At its timeout a sandbox is killed, or with
  `onTimeout: pause` paused the same way.
- **The pause and the timeout are durable.** The service writes the
  lifecycle state first (`pausing`, `killing`), then acts, then writes the
  end state. A sweeper in every replica finishes a pause or kill that a
  crash cut short, and applies timeouts, so the state a client was given
  is the state it will find. Each transition the sweeper begins is
  conditional on the version of the record it read, so a timeout moved
  meanwhile wins. Each round reads every due record, a page at a time,
  so records it cannot finish yet never hold up later ones. Pausing asks
  the owner host to sleep the
  sandbox to Saved and waits for the host to report it there; an idle
  sleep, which the host may undo on any request, is something else and
  never shows through the API.
- **A resume carries the token the sandbox kept.** After a restore the
  guest gives envd its `/init` again with the access token recorded at
  create, so envd still refuses requests without it. A clone from a
  template gets its own token at create instead.
- **An open stream counts as someone connected.** The SDK and envd keep
  command and PTY streams alive with a heartbeat every 50 s, so a sandbox
  with such a stream open stays awake, as our sleep model already says of
  people or apps connected, until the stream ends or its E2B timeout
  passes. That is E2B's own behaviour too: its sandboxes run until their
  timeout. A command started in the background with no stream left open
  does not hold it awake. Tests check both. The front door holds the
  sandbox through a host hold with a 45 s time to live, renewed every
  15 s while any stream is open and released 2 s after the last one ends.
  Each replica keeps its own hold; a pause ends each replica's streams
  and its hold as that replica's sweeper sees it, and asks the host again
  until the save is done.
  Heartbeats move nothing: not the E2B timeout, which only connect and
  set-timeout move, and not the hold, which only open streams keep.
- **Traffic reaches the guest through the owner host's `connect`.** A
  request names its sandbox and port by host name (`<port>-<id>.<domain>`)
  or by the `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers. The front door
  routes each HTTP request, keeping a small pool of streams per sandbox and
  port. A kept stream is open on the host, so it holds the sandbox awake
  like any open stream; streams are kept only 2 s, then closed. envd's
  access token passes through; a sandbox created without public traffic
  also needs its traffic token on user ports. A pause or kill ends every
  stream through the front door. The traffic token is checked before
  anything else, auto-resume included. A request re-reads the lifecycle
  once its stream to the guest is open, so a pause another replica
  finished meanwhile is not undone: the request is not forwarded, and a
  sandbox its connect woke is saved again.
- **TLS: either the front door or a terminator in front.** The SDK uses
  HTTPS for the API and for `<port>-<id>.<domain>`. With `--e2b-tls-cert`
  and `--e2b-tls-key` the front door serves HTTPS itself, with one
  certificate for the API's name and `*.<domain>`. Without them it speaks
  plain HTTP, for a load balancer that terminates TLS with that
  certificate. Clients that cannot use a wildcard name can send every
  request to one address with the `E2b-Sandbox-Id` and `E2b-Sandbox-Port`
  headers (the SDK's `E2B_SANDBOX_URL`).
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
  token, default user and directory) and after a restore, with the time
  and the access token the sandbox keeps, which envd checks first. A clone
  of a ready template is a create: it gets its own `/init`, with its own
  environment and token, before anyone can reach it. The sandbox is ready,
  and the service routes to it, only once `/init` succeeded.
- **Images from OCI.** The service builds an image from a reference in any
  OCI registry (Docker Hub, GHCR, Google and Azure registries; anonymous or
  with a token): it applies the layers, whiteouts included, into an ext4
  file, adds `compute-guest` and envd, keeps the image's user, directory,
  environment and command, and stores the file in object storage by
  digest. A sandbox's config names its image; a host fetches and caches
  images by digest and keeps templates per image and shape. An image a
  host kept across a restart is checked against its digest and used
  without asking the store. An E2B
  template id names one of these images.
- **What every image gets, for the SDK to work.** The SDK runs commands
  as `/bin/bash -l -c` and starts PTYs with bash, and envd looks users up
  in the image's account files. So the build adds a static bash at
  `/bin/bash` when the image has none, and a `user` account (E2B's default
  user, uid 1000, home `/home/user`) when there is none. The image's own
  `ENTRYPOINT` and `CMD` run as one supervised process, as `docker run`
  would, under the image's `USER`, named or numeric (a number with no
  account entry runs as that number), with the image's environment and
  then the sandbox's. Commands from the SDK run as the user it names,
  `user` by default.
- **When the image's command runs.** Never in a template: whatever it
  made would be copied into every clone. It starts once a sandbox has its
  own identity and has taken its create's init, so it sees its own
  machine id, environment and random numbers. A restore from memory finds
  it running; a boot from the sandbox's own disk starts it again, as a
  container restart would. A sandbox that never gets an init (the native
  API gives none) does not run it. Children start with no signal blocked,
  so the command can handle the `SIGTERM` a shutdown sends; five seconds
  later the rest are killed.
- **The guest keeps the init for good before it answers.** It writes the
  init to the sandbox's disk (a new file, readable only by root, synced,
  renamed, directory synced), then
  gives it to envd, then answers `ok`. If envd fails, the kept init
  stands and goes to envd with the retry or the next restore, so disk,
  guest and envd never disagree for long. An init file that is there but
  cannot be read holds envd back, rather than run it without the
  sandbox's access token, until a new init replaces it.

## Consequences

- Unchanged E2B clients work, and wake transparently: a sandbox that is
  asleep answers its first request after the wake.
- E2B features left out for now: its template build steps, volumes, MCP,
  IAM, egress rules, sandboxes without internet access, secrets, teams,
  metrics and logs endpoints, snapshots by id and forks. Opengeni's e2b
  backend does not need them, except its optional native snapshot
  persistence; with the tar persistence it uses by default it works
  unchanged.
- envd is Go and costs a few MiB per guest. Replacing it later with our own
  would change nothing outside the guest.
- A guest's own init system, if it has one, does not run; the image's
  command is started by `compute-guest` instead.
- A sandbox with an open terminal does not sleep. That costs memory, as on
  E2B, but never hides a running program behind a sleep.
