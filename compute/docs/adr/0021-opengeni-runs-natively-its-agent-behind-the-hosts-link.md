# 21. Opengeni runs natively: its machine agent in every sandbox, behind the host's link

Status: Accepted, 2026-10-18. Supersedes [20](0020-opengeni-runs-on-the-fabric-through-its-e2b-backend.md)
for Opengeni; the E2B front door ([19](0019-e2b-compatible-front-door-and-guest-init.md))
stays for E2B clients. The wire protocol is in [agent-link.md](../agent-link.md).

## Context

ADR 20 ran an Opengeni session on the fabric through Opengeni's e2b
backend. That proved the fabric, not the integration Opengeni needs.
Through E2B, Opengeni has no interactive terminal, no checked desktop or
browser, no run-as and no bucket mounts. It carries workspaces as tar files
because it cannot see the fabric's own saves, and it adds a translation
layer, and envd in every guest, to reach programs that Opengeni's own
machine agent already knows how to run.

That agent is the program a Connected Machine runs. It gives Opengeni
journaled commands that survive a lost connection, background commands with
durable output, transactional file writes, git, a real terminal, desktop
frames, browser control and ports. It talks to Opengeni over NATS: it dials
one long-lived connection, authenticates with its enrollment's bearer
(Opengeni's authorization callout checks it, claims the agent's connection
and grants it its own subjects, `agent.<workspace>.<agent>.connection.<instance>.>`),
and dials Opengeni's relay for streams. Opengeni's code for all of that is
keyed to the agent's enrollment and its live connection.

A sandbox sleeps; a Connected Machine does not. A sandbox that holds its own
NATS connection loses it within minutes of sleeping, because NATS drops a
client that misses two keepalives two minutes apart. A message for it then
fails at once with "no responders": nothing in between knows to wake it.
Every restore costs a reconnect through TLS, the callout and a database
claim before the first command runs, and every sandbox holds credentials.

The options were:

1. **Keep the e2b backend (ADR 20).** Leaves the gaps above.
2. **A `compute` backend that speaks the fabric's API and envd.** Rebuilds,
   against a second protocol, what the agent already does.
3. **The agent in every sandbox, dialing NATS as a Connected Machine
   does.** The agent and Opengeni stay unchanged, but with the problems
   above: dropped connections and messages while asleep, a reconnect after
   every restore, and a credential in every sandbox.
4. **The agent in every sandbox, reached through its host.** The host
   agent keeps one link to Opengeni for all its sandboxes and relays each
   sandbox's control traffic over vsock, waking the sandbox when a message
   arrives for it.

## Decision

Option 4, the design proposed on 2026-10-15 (the explainer's sections 13
and 16.1).

- **Images.** Opengeni's sandbox and desktop images carry `opengeni-agent`,
  built from the same commit as the rest of Opengeni, at
  `/usr/local/bin/opengeni-agent`. The fabric builds its images from them
  like any OCI image (ADR 19). Another backend ignores the binary.
- **A create names the agent, without a secret.** The native API's create
  takes ADR 19's `init`, now with an `agent` section: the workspace and
  agent ids of the sandbox's enrollment, the relay's address, the
  workspace root, and whether to start a virtual desktop. The guest keeps
  it on its disk before it answers, as it does for envd. A clone from the
  ready pool is a create and gets its own init, so no two sandboxes share an
  identity. A create is idempotent by the caller's `request_id`.
- **The guest runs the agent and gives it a local NATS address.**
  When the init has an `agent` section, `compute-guest` starts
  `opengeni-agent` in fabric mode as root, supervises it, and forwards
  every connection to `127.0.0.1:4222` in the guest to the host over vsock
  (port 58). The agent dials that address with no credential. Fabric mode
  also turns off what does not belong in a sandbox: enrollment, credential
  renewal, self-update (the image pins the agent) and service
  installation.
- **The host speaks NATS to its guests and keeps their sessions.** The
  host agent answers each guest's NATS connection itself, knowing from the
  vsock socket which sandbox it is. For each sandbox it keeps one session
  on its link to Opengeni: the guest's subscriptions, opened upstream once,
  stay open while the sandbox sleeps and across the guest's reconnect
  after a restore, when it subscribes again. The guest's publishes go up
  the same session. A message that arrives for a sandbox that is not
  running wakes it, as any traffic does, and is delivered once the agent
  has subscribed again; a wake that fails drops what waited, and the
  sender's own retry, under its replay identity, takes over. A message to a
  sandbox counts as activity, so it stays awake while used; what the agent
  publishes (its heartbeats, every five seconds) does not, so an idle
  sandbox still sleeps. The host keeps each session's connection instance
  and subscriptions in the sandbox's record, so a restarted host agent
  opens them again before its guests run.
- **One link per host and Opengeni deployment.** The host agent dials
  Opengeni's agent gateway: a WebSocket over TLS, authenticated by a host
  token the fleet service signs (Ed25519) for that gateway and renews with
  the host's lease. A link is opened when the first sandbox that needs it
  arrives and kept while any does. Which gateway a team's sandboxes use is
  the fleet's configuration for the team, never something a create names,
  so a host never presents its token to an address a tenant chose.
- **Each session is fenced by the sandbox's owner epoch.** The host opens a
  session with a ticket the fleet service signed when it gave the sandbox
  to the host: the sandbox, its team, its agent's workspace and agent ids,
  the host and the owner epoch (ADR 18). Opengeni's gateway checks the
  signature, that the team is the one Opengeni uses and that the agent's
  enrollment is an active sandbox enrollment, then claims the agent's
  connection exactly as the NATS callout does and enforces the same
  subject permissions. It keeps the highest epoch it has seen per sandbox:
  an older one is refused and a newer one ends any other session for that
  sandbox, so a host the fleet gave up on cannot speak for a sandbox that
  moved. While its session is open the gateway keeps the connection's lease
  live, so a sleeping sandbox is reachable rather than offline.
- **Streams go to the relay as on a Connected Machine.** Terminals,
  desktop frames and ports are dialed by the agent to Opengeni's relay,
  with a relay producer token the gateway mints for an hour when the
  session opens and again before it expires. The host passes it to the
  guest, which keeps it in memory-backed `/run` only. It can register
  streams for that one agent and nothing else; no sandbox holds a
  credential that reaches Opengeni's control plane.
- **After a restore the agent reconnects at once.** The restore notice
  already tells the guest that its connections are gone and what time it
  is. `compute-guest` passes this on to the agent, which dials its local
  address again without the back-off it uses for an outage: a vsock
  connection and a NATS handshake with its own host, about a millisecond.
  A Paused sandbox keeps its connection.
- **Idle includes the agent.** The host already asks a guest how many
  quiet commands it runs before it sleeps it for being idle (ADR 3). The
  guest now adds counts that guest programs register as files under
  `/run/compute/activity/`. The agent registers its running operations, its
  open terminal, desktop and port streams that moved bytes within the
  stream silence limit, and its attached browser and computer controllers.
  So a sandbox sleeps only when the agent is idle too, and an open
  terminal, desktop or browser view keeps it awake, as ADR 3 promised.
- **A sandbox with no owner is woken through the fleet service.** A
  sandbox whose host was lost, or that was handed off and not yet adopted,
  has no session, so a message to it finds no responder. Opengeni's
  backend then asks the fleet service to wake it, which places and adopts
  it (ADR 18); the new owner opens its session, and the request is
  retried, under its replay identity, until the agent answers. This is the
  only case in which Opengeni wakes a sandbox itself.
- **Opengeni has a `compute` backend.** It is a managed sandbox like Modal:
  sessions, groups, leases, workspace setup, repositories, git
  credentials, secrets and usage work as for any managed backend. Its
  provider session is the agent session Connected Machines use, so
  commands, files, git, terminal, desktop, browser and ports are the same
  code.
  - Create: make the sandbox's enrollment, create the sandbox on the
    fabric with its init (idempotently, by Opengeni's request id) and wait
    for the agent's first Hello through the gateway.
  - Resume: nothing to do; the next request wakes the sandbox.
  - Idle sandboxes sleep on the fabric. Opengeni never tears one down for
    being idle and never needs to capture it to keep it: the fabric keeps
    memory and disk, archives them and brings them back after a move or
    the loss of a host. A tar capture is taken only to carry a workspace
    to another backend. The sandbox is deleted, and its enrollment
    revoked (which ends its session), when its group ends.
- **A sandbox's enrollment is not a Connected Machine.** It has kind
  `sandbox`: it is not listed, offered or attachable as a machine, its
  use is authorized by its lease rather than by machine grants, it has no
  bearer, and it ends with the sandbox.
- **A Connected Machine is the other case of the same agent and code.** It
  runs the same agent and Opengeni serves it with the same session code;
  it is pinned to its owner, never sleeps and is never moved, so it dials
  NATS itself and needs no host in between. The fleet service does not
  list Connected Machines: there is no host agent on a person's computer,
  and adding one would put a second daemon there for nothing either side
  uses.

## Consequences

- Every feature Opengeni has on a Connected Machine works on a fabric
  sandbox, and a fix to either serves both.
- The model sees what it sees on a Connected Machine; nothing already sent
  changes, as only new sessions on the new backend use it.
- Opengeni's NATS server holds one connection per Opengeni API replica for
  all sandboxes, not one per sandbox, and authorizes a sandbox once per
  owner, not once per restore.
- A guest runs the agent (measured in `docs/measurements.md`) and no
  envd, unless its image also serves E2B clients.
- A sandbox's first command after a sleep waits only for the wake and the
  agent's local reconnect; measured per sleep level.
- Opengeni's gateway carries every sandbox's control traffic. It is part of
  Opengeni's API, so it scales with it; each host's link lands on one
  replica, and a host whose link drops dials again and reopens its
  sessions, during which a request is retried under its replay identity.
- The host speaks a subset of the NATS client protocol to its guests
  (connect, ping, subscribe, unsubscribe, publish with and without
  headers), so the agent's NATS client runs unchanged.
- Modal and the other backends stay selectable per deployment, and the
  default does not change.
