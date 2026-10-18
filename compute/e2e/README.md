# The end-to-end environment and suite

Real agent sessions on a real fabric: a full Opengeni stack built from one
commit, with `OPENGENI_SANDBOX_BACKEND=compute`, against compute-control
and a fleet of nested-virtualization hosts on Google Cloud, driven through
Opengeni's public API with a real model. Everything runs in one project;
the workstation only drives it.

## What it brings up

`env.sh up` (each step also runs alone; all are idempotent):

1. **infra**: static addresses for the stack VM (external and internal) and
   for Cloud NAT, a router and NAT for the hosts (they have no public
   address), firewall rules on the stack VM's tag (SSH from the workstation
   only; HTTPS from the workstation, the NAT address and the stack itself;
   port 80 for Let's Encrypt's challenges), an Artifact Registry repository.
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
   images from `OPENGENI_REF` (the API's artifact runtime bundle is copied
   from a published canary API image, since release automation builds it);
   the sandbox and desktop images, with Opengeni's agent added when an image
   lacks it; compute-control's image and the host bundle from
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
   address (sslip.io). It waits for `HOSTS` live hosts.

Hosts reach the fleet service on the internal network, and Opengeni's agent
gateway and relay over HTTPS through the NAT. NATS stays inside the cluster.

## The suite

`env.sh model-up` makes an Azure OpenAI deployment named after the model
(`MODEL_NAME`, `MODEL_VERSION`); `deploy` hands it to Opengeni; `suite` runs
`suite/run.ts` on the stack VM and copies the results to
`$STATE/runs/<run>/` (results.json, results.md, logs, screenshots);
`model-down` deletes the deployment. `ONLY=create,git env.sh suite` runs a
subset with what it needs.

| check | what it does |
| --- | --- |
| health, hosts, workspace | the API answers; the fleet has `HOSTS` live hosts; a workspace exists |
| create | a session with `sandboxBackend: compute` runs its first turn (the agent runs `uname -r`); the fabric holds its sandbox |
| commands | `terminal/exec` runs a command |
| background | the agent runs a background command; the API lists it |
| files | `fs/write`, `fs/read` and `fs/list` (the file browser's API) agree |
| git | `git/status` and `git/log` of a repository made in the sandbox |
| terminal | a PTY opened through the API echoes a typed command on the event stream |
| port | an HTTP server in the sandbox answers through the fabric's `connect` stream |
| browser | the agent opens a page with the in-sandbox browser and reports its title |
| desktop | the agent opens a computer session, takes a screenshot and describes it |
| run-as | not applicable while Opengeni never runs commands as another user |
| sleep-paused, -saved, -archived, -remote | the fabric puts the sandbox to sleep at that level; the next Opengeni request wakes it, with its files |
| move | the fabric moves the sandbox to another host; its files come along |
| host-loss | after a sleep to remote, the sandbox's host is stopped; the sandbox wakes on another host from that copy |
| ui | Playwright in the web app: the Files tab lists the file, a command typed in the Terminal tab runs, the Desktop tab draws the desktop |

A check whose needs failed is skipped, so every run reports every check.

## Settings and cost

See the header of `env.sh`. Defaults: three n2-standard-8 hosts, an
n2-standard-32 stack VM with 500 GB of SSD, one Cloud NAT, an Enterprise
certificate authority. Run `env.sh down` (and `model-down`) when done: it
deletes the VM, everything Terraform made, the registry, NAT, addresses
and firewall rules. State, keys and results stay in `$STATE`, outside the
repository.

The stack has no login (the chart's default local access mode); its HTTPS
front only admits the workstation, the hosts' NAT address and itself.
