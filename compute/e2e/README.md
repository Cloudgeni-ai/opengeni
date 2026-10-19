# The end-to-end environment and suite

Real agent sessions on a real fabric: a full Opengeni stack built from one
commit (or several branches merged), with `OPENGENI_SANDBOX_BACKEND=compute`, against compute-control
and a fleet of nested-virtualization hosts on Google Cloud, driven through
Opengeni's public API with a real model. Everything runs in one project;
the workstation only drives it.

## What it brings up

`env.sh up` (each step also runs alone; all are idempotent):

1. **infra**: static addresses for the stack VM (external and internal) and
   for Cloud NAT, a router and NAT for the hosts (they have no public
   address), firewall rules on the stack VM's tag (SSH from the workstation
   only; HTTPS from the workstation, the NAT address and the stack itself;
   port 80 for Let's Encrypt's challenges), SSH to the hosts from the stack
   VM's internal address only (for their journals), an Artifact Registry
   repository.
2. **fleet**: `deploy/terraform/gcp-compute` with this environment's
   settings: service accounts, the fleet's certificate authority, the
   fleet service's host-endpoint certificate, the archive bucket (deleted
   with its objects on `down`), firewall rules between the stack and the
   hosts, the host template and an empty zonal group the fleet service
   grows to `HOSTS`.
3. **stack**: one VM (`STACK_MACHINE`) running as the fleet service's
   account, with Docker, k3s, Helm, Caddy, Rust and Bun, and checkouts of
   `OPENGENI_REF` and `COMPUTE_REF`.
4. **build** (`stack/build.sh`): Opengeni's api, worker, web and relay
   images from `OPENGENI_REF`, merged on the VM with each ref in
   `OPENGENI_MERGE_REFS` (for branches that are not yet on one branch; a
   fixed identity and date make the same inputs give the same commit). The
   API's artifact runtime bundle is copied from a published canary API
   image, since release automation builds it. The sandbox and desktop
   images come from the same checkout and must install
   `/usr/local/bin/opengeni-agent`, which the guest runs in fabric mode
   (ADR 21); the build fails otherwise. Then compute-control's image and the host bundle from
   `COMPUTE_REF`; the stored sandbox images, made with
   `compute-host build-image` into the archive.
5. **fleet** again, now naming the real host bundle.
6. **deploy** (`stack/deploy.sh`): generated secrets; the chart from
   `COMPUTE_REF` with its Postgres, Temporal, NATS and Garage fixtures, the
   relay, compute as the deployment's backend and `computeControl` enabled
   (its own schema and role, API over TLS from an environment authority,
   hosts endpoint as a NodePort, a link signing key, Opengeni's team link
   to the API's agent gateway); Caddy in front with Let's Encrypt
   certificates for `opengeni.`, `relay.` and `files.` names of the VM's
   address (sslip.io). It waits for `HOSTS` live hosts. The chart's default
   two relays run behind Caddy as a stock install has them, a plain reverse
   proxy to the relay Service: any replica forwards a terminal's dial to the
   one that owns its channel. The fleet checkpoints running sandboxes every
   60 s (`--checkpoint-every-s=60`), so every check runs across checkpoints.
   `FRESH=1 env.sh deploy` first removes the release and its volumes, for a
   new database, object store and NATS.

Hosts reach the fleet service on the internal network, and Opengeni's agent
gateway and relay over HTTPS through the NAT. NATS stays inside the cluster.

## The suite

`env.sh model-up` makes an Azure OpenAI deployment named after the model
(`MODEL_NAME`, `MODEL_VERSION`) and records it in `$STATE/model.created`
(account, group, name and Azure's creation time); `deploy` hands it to
Opengeni; `suite` runs `suite/run.ts` on the stack VM and copies the results
to `$STATE/runs/<run>/` (results.json, results.md, logs, screenshots);
`model-down` deletes the deployment only if it matches that record, so a
deployment this environment adopted rather than created is left alone. The deployment runs turns with the
managed deployment's sandbox rollout controls (turns own their sandbox's
lease, lazy provisioning), which the compute backend needs. `ONLY=create,git env.sh suite` runs a
subset with what it needs (an unknown name is an error); `KEEP=1` keeps the
run's session for inspection (delete it afterwards).

Every check is meant to fail when the feature it names is broken: it asserts
an effect the feature alone produces (a random value, a process id, a decoded
frame), not only that a request was accepted.

| check | what it does |
| --- | --- |
| health, hosts, workspace | the API answers; the fleet has `HOSTS` live hosts; a workspace exists |
| create | a session with `sandboxBackend: compute` runs its first turn (the agent runs `uname -r`); the fabric holds its sandbox |
| commands | `terminal/exec` runs a command, and a failing one keeps its exit status, stdout and stderr |
| egress | a command in the sandbox fetches a public HTTPS page |
| background | the agent runs a background command to completion and reads its output and exit status back by id; a long one is listed by the API while it runs, and stopping it through the API unlists it and ends its processes in the guest |
| files | `fs/write`, `fs/read` and `fs/list` (the file browser's API) agree |
| git | `git/status` and `git/log` of a repository made in the sandbox |
| terminal | a terminal opened through the viewer relay runs a typed command, which writes a random value to a file that is then read back |
| checkpoint | while the host checkpoints the running sandbox, a terminal ticks for 150 s and a `terminal/exec` command ticks for 110 s alongside: every tick arrives, the terminal is never quiet for 10 s or closed, and `suite/verify.ts` requires a completed checkpoint step in the hosts' journals inside each window |
| port | an HTTP server on a guest TCP port answers through the fabric's `connect` stream to the guest gateway (vsock 57, header `tcp <port>`); this is the fabric's stream, not an Opengeni preview URL |
| browser | a page with a random title is served in the sandbox; the agent opens it with the browser tools, a tool result carries the title and the reply names it |
| desktop | the agent's computer session becomes active, a computer tool call succeeds, and a screen frame fetched through the API decodes as a real desktop (at least 640x400, several colours) |
| run-as | not applicable: Opengeni never asks any backend to run a sandbox's commands as another user (the runtime's `sandboxRunAs` gives none), so no public API reaches it; the compute agent advertises `run_as`, which the agent's Linux tests cover as root |
| sleep-paused, -saved, -archived, -remote | the fabric puts the sandbox to sleep at that level, and the host's state (`GET /v1/sandboxes/{id}/state`) must report the level with no step under way and keep it 3 s; the next Opengeni request wakes it, with its files, the same boot generation and a running process that holds 32 MiB of known memory (same pid, memory intact). After the run, `suite/verify.ts` checks the hosts' journals: the sandbox's last completed step before the wake must have reached that level, or the check fails; the next step must be the wake from that level, begun at or after the suite's request, with no other step under way between the level and the request; that wake must be by the agent link (`compute.wake.by` is `agent_link`), and every wake inside a sleep's window and the one that ends it are reported with what asked for it. Before each pause to save or checkpoint, the host asks the guest to write its disks out and warns only when it does not; such a warning for the sandbox inside a sleep's or checkpoint's window fails that proof, and the verifier notes every one in the run. The saved sleep's wake is a paged restore: on the host that restored it, the pager must write `learned.json` at or after the request, within 60 s, and `pager.log` may say "Permission denied" at most once |
| link-stream | for at least 170 s, and on until the host's state, looked at after each transfer, has shown two checkpoints begin and end and one more transfer has run after the second (failing if that takes more than 330 s, one deadline over every transfer and look), 4 MiB of random bytes written through the files API and read back, and 4 MiB the guest makes read through it, each cycle compared by sha256 (the guest's and the API's); then a sleep to Saved woken by a read, after which every file matches both ways. The journals must show at least two checkpoints begun and completed during the transfers and the saved sleep as the sleep checks verify it, and the host journal must record exactly one VMM launch for the wake from Saved and none before it (a journal that cannot be read fails the check), and the guest console on the host must show no new agent connection ("connected to control plane", "reconnecting at once", "lost this sandbox's connections") during the transfers or across the sleep |
| vm-crash | a write, then a running checkpoint the host's state shows begin and end, then a second write and a command left running (`sleep 30`), then the suite kills that sandbox's Firecracker process on its host (by the jail's pid file, checked to be Firecracker started for that sandbox). As ADR 10's crash table has it, the host boots the sandbox again from its disk: the next command must answer within one 240 s deadline on the same host with both writes (the disk is not rolled back to the checkpoint), the boot generation one higher, a running 32 MiB process gone, and a `programs_lost` alarm for the sandbox in the host journal. The command in flight must end with an error within 90 s of being sent (its 60 s timeout plus 30 s), neither hanging nor reporting success; it is cut off at that bound, and a later answer fails. The host journal must say how many times the VMM launched (one, after the kill), and a journal that cannot be read fails the check. The guest console (the dead VMM's to its end, then the new one's) must show exactly one agent connection; the old streams must end by evidence of this sandbox: its guest told they were lost, or a host journal line carrying `sandbox=<id>` ending them. No host line carrying `sandbox=<id>` may say a stream broke the protocol, a connection did not say hello, or there were too many agent-link connections. A move or drain hands memory over; a crash or a host loss boots from files |
| move | the sandbox sleeps (Saved) and the fabric moves it to another host; its files come along |
| host-loss | after a sleep to remote that the host's state confirms and a wake, the suite starts a program, writes a file without a sync and waits for a running checkpoint the host's state shows begin and end after it, writes a late file, sends a command that notes the guest's boot id and would run on, and stops the sandbox's host. The sandbox must come back on a different live machine under a higher owner epoch, and the lost host no longer own it. After a host loss it boots from its last copy's files, never from that copy's memory (ADR 18): the adopting host's journal since the stop must show exactly one VMM launch, one `boot` step and no `restore`, and an "adopted from its files" line and a `programs_lost` alarm for the sandbox; the guest's boot id must change (the boot generation is reported, not compared: each owner numbers its boots afresh, so generations compare only under one owner epoch); the enrollment's agent connection instance must change; the program must be gone; the archived file and the checkpointed write must be kept, and the late write lost when the stop completed before the next checkpoint was due (a minute of running after the last began; kept when the kept journal shows a copy begun after it); the guest console of the new launch must show one agent connection. The adopting host's instance and boot, its journal and the console are read in one go, with the sandbox's running VMM (its pid, that process's start time and the console's inode) read before and after the journal and console and required to be the same, so no launch comes between them. The command in flight must end within 120 s of the sandbox answering again as an outcome unknown: a 409 whose `error.message` is exactly one of the answers Opengeni gives when the machine's agent was replaced before the outcome was known (the text the model's tool result carries too), with no `outcomeUnknown` other than true, never an exit status; it is not sent to the new agent instance, so it may not run again on the new boot (its file may not hold the new boot id) or be running after the loss. The instance group recreates a stopped host under its old name, so machines are told apart by GCE instance id: a same-named owner must have a different id and a strictly higher host epoch than the one known before the stop. Before the stop the suite keeps the host's journal as `host-<name>@<instance>.log`, read on that machine, with its metadata server's instance id and its boot id in the header (another machine fails the check). The stop's operation must name that instance. The verifier reads a kept journal only if its name is well formed, a check of the run declared it (host, instance and boot), and its header names that instance and boot; it then serves host-loss's own proofs (the kept journal and the checkpoint) and earlier proofs made on that host |
| delete | deleting the session deletes its sandbox on the fabric |
| cleanup | every session delete, viewer close and machine revoke the run made succeeded (not applicable with `KEEP=1`) |
| connected-machine | the agent build from the sandbox image connects the stack VM as a Connected Machine (an enroll token, `opengeni-agent connect`, then `run`); a session made to use it runs a command and a model turn there; through 90 s idle the machine is listed online at every 5 s poll and its agent process stays alive, then it answers at once; the machine is then revoked |
| ui | Playwright in the web app: the Files tab lists the file, a command typed in the Terminal tab runs, the Desktop tab draws the desktop |

A check whose needs failed is skipped, so every run reports every check.

The link-stream, vm-crash and saved-sleep pager checks reach the hosts from the stack VM
over OS Login as the stack VM's own identity (a key the suite registers
for a day, then ssh to the host's internal address):
`env.sh fleet` grants it `roles/compute.osAdminLogin` on this
environment's host instances only (an IAM condition on their names), and
`env.sh down` removes the grant (`status` lists it while it exists).

After each run `suite` also copies every host's `compute-*` journal since
the run began into the run's results (`host-<name>.log`), over OS Login
through the stack VM, with the guest consoles of the run's sandboxes (copied every minute while the run goes on, since a console goes with its sandbox);
`env.sh host-logs [run]` does it alone. `suite` then runs `suite/verify.ts`
on those journals and exits nonzero if any check failed or was skipped, the
remote run failed or no results came back. Each check has 30 minutes; one
that hangs is aborted (its requests are cancelled) and fails, and the run goes
on.

## Settings and cost

See the header of `env.sh`. Defaults: three n2-standard-8 hosts, an
n2-standard-32 stack VM with 500 GB of SSD, one Cloud NAT, an Enterprise
certificate authority. Run `env.sh down` (and `model-down`) when done: it
deletes the VM, everything Terraform made, the registry, NAT, addresses
and firewall rules. It carries on past a failed step and lists whatever is
left at the end; `env.sh status` lists everything that still costs money,
including the certificate pool, custom roles and the model deployment. State, keys and results stay in `$STATE`, outside the
repository.

The stack has no login (the chart's default local access mode); its HTTPS
front only admits the workstation, the hosts' NAT address and itself.
