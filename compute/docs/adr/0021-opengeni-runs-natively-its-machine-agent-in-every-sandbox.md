# 21. Opengeni runs natively: its machine agent in every sandbox

Status: Accepted, 2026-10-18. Supersedes [20](0020-opengeni-runs-on-the-fabric-through-its-e2b-backend.md)
for Opengeni; the E2B front door ([19](0019-e2b-compatible-front-door-and-guest-init.md))
stays for E2B clients.

## Context

ADR 20 ran an Opengeni session on the fabric through Opengeni's e2b
backend. That proved the fabric, not the integration Opengeni needs. Through
E2B, Opengeni has no interactive terminal, no checked desktop or browser,
no run-as and no bucket mounts. It carries workspaces as tar files because
it cannot see the fabric's own saves. It also adds a translation layer, and
envd in every guest, to reach programs that Opengeni's own machine agent
already knows how to run.

That agent is the program a Connected Machine runs. It already gives
Opengeni journaled commands that survive a lost connection, background
commands with durable output, files with transactional writes, git, a real
terminal, desktop frames, browser control and ports, over a NATS control
connection it dials and a relay for streams. Opengeni's code for all of
that is keyed to the agent's enrollment and its live connection.

The options were:

1. **Keep the e2b backend (ADR 20).** Leaves the gaps above.
2. **A `compute` backend that speaks the fabric's API and envd.** Rebuilds,
   against a second protocol, what the agent already does.
3. **The agent in every sandbox, reached over the fabric's `connect`**
   instead of NATS. Opengeni's journaled commands, background command
   custody, output release, replay and liveness are all keyed to the
   agent's control connection; a second transport would duplicate each.
4. **The agent in every sandbox, dialing Opengeni as a Connected Machine
   does, with Opengeni owning the sandbox as a managed sandbox.**

Phase 1 proposed a variant of 4 in which each host holds one NATS link for
all its guests and relays it over vsock, waking a guest when a message
arrives for it. It is not needed and is not built: the agent already
recovers from a connection that died while it slept; a sandbox that sleeps
off any host (Remote), or that moved, has no host to receive a message, so
Opengeni has to ask the fabric to wake it anyway; and a host-side relay
would re-implement the agent's authentication and subject routing in host
code that every guest's control traffic would then depend on. It stays an
option if measured wakes ever need it.

## Decision

Option 4.

- **Images.** Opengeni's sandbox and desktop images carry `opengeni-agent`,
  built from the same commit as the rest of Opengeni, at
  `/usr/local/bin/opengeni-agent`. The fabric builds its images from them
  like any OCI image (ADR 19). Another backend ignores the binary.
- **A create gives the guest its init** (ADR 19's `init`, now also on the
  native API): the environment, default user and directory, and an
  `agent` section with the deployment's API address, a single-use
  sandbox enrollment token and the workspace root. The guest keeps the
  init on its disk before it answers, as it does for envd. A clone from
  the ready pool is a create and gets its own token, so no two sandboxes
  share an identity.
- **The guest runs the agent.** When the init has an `agent` section,
  `compute-guest` starts `opengeni-agent` in fabric mode as root and
  supervises it. The first start exchanges the token for the agent's own
  credentials, which it keeps on the sandbox's disk. From then on the agent
  dials NATS and the relay exactly as on a Connected Machine. Fabric mode
  turns off what does not belong in a sandbox: self-update (the image
  pins the agent), service installation and the installer's machine
  checks.
- **After a restore the agent reconnects at once.** The restore notice
  already tells the guest that its connections are gone and what time it
  is. `compute-guest` passes this on to the agent, which drops its
  connections and dials again without the back-off it uses for an outage,
  renewing its short-lived NATS credential first if it expired while the
  sandbox slept. A Paused sandbox keeps its connections; if the server
  closed one meanwhile, TCP tells the agent as soon as the guest runs.
- **Idle includes the agent.** The host already asks a guest how many
  quiet commands it runs before it sleeps it for being idle (ADR 3). The
  guest now adds counts that guest programs register as files under
  `/run/compute/activity/`. The agent registers its running operations, its
  open terminal, desktop and port streams that moved bytes within the
  stream silence limit, and its attached browser and computer controllers.
  So a sandbox sleeps only when the agent is idle too, and an open
  terminal, desktop or browser view keeps it awake, as ADR 3 promised.
- **Opengeni has a `compute` backend.** It is a managed sandbox like Modal:
  sessions, groups, leases, workspace setup, repositories, git
  credentials, secrets and usage work as for any managed backend. Its
  provider session is the agent session Connected Machines use, so
  commands, files, git, terminal, desktop, browser and ports are the same
  code.
  - Create: mint a single-use sandbox enrollment token bound to the
    lease, create the sandbox on the fabric with that token in its init
    (idempotently, by Opengeni's request id), and wait for the agent's
    first Hello.
  - Resume: ask the fabric to wake the sandbox (nothing to do if it runs)
    and wait until its agent answers.
  - Before each control request, if the sandbox may have slept since its
    agent last answered, the client asks the fabric to wake it first. A
    no-responder after a wake is retried, under the existing replay
    identity, until the agent has reconnected.
  - Idle sandboxes sleep on the fabric. Opengeni never tears one down for
    being idle and never needs to capture it to keep it: the fabric keeps
    memory and disk, archives them and brings them back after a move or
    the loss of a host. A tar capture is taken only to carry a workspace
    to another backend. The sandbox is deleted, and its enrollment
    revoked, when its group ends.
- **A sandbox's enrollment is not a Connected Machine.** It has kind
  `sandbox`: it is not listed, offered or attachable as a machine, its
  use is authorized by its lease rather than by machine grants, and it
  ends with the sandbox. A Connected Machine is the other case of the same
  agent and code: owned by a person or workspace, never provisioned and
  never asleep.

## Consequences

- Every feature Opengeni has on a Connected Machine works on a fabric
  sandbox, and a fix to either serves both.
- The model sees what it sees on a Connected Machine; nothing already sent
  changes, as only new sessions on the new backend use it.
- A guest runs the agent (measured in `docs/measurements.md`) and no envd,
  unless its image also serves E2B clients.
- A sandbox's first command after a sleep waits for the wake and, after a
  restore, for the agent to reconnect; measured per sleep level.
- Opengeni's maintenance passes that address an agent directly (background
  command reconciliation, output release) see a sleeping sandbox as
  offline and wait, as they do for a machine that is offline; nothing is
  lost, because the agent keeps its output across sleep.
- The sandbox holds credentials for its own agent identity only, as a
  Connected Machine does. Code in the sandbox already controls everything
  that identity can do.
- Modal and the other backends stay selectable per deployment, and the
  default does not change.
