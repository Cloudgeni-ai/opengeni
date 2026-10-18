# Operations

How to deploy and run Opengeni compute in production, and what an operator
must set up, check and know that the code cannot enforce alone. Each point
says what the fabric does, what is left to the deployment, and what we
chose not to build.

- [Deploying](#deploying): the fleet service, the hosts, and Opengeni's
  settings
- [Hosts](#hosts): adding, draining and removing them; a lost host
- [Keys and certificates](#keys-and-certificates), [Backups](#backups),
  [Security](#security)
- [Storage](#storage), [Deleting](#deleting), [Observing](#observing),
  [Upgrades](#upgrades), [Emergencies](#emergencies), [Network](#network),
  [Capacity and cost](#capacity-and-cost)
- [Testing](#testing): CI, the KVM gate, the cloud gate and the end-to-end
  suite

## Deploying

A deployment has three parts:

| Part | What | Shipped as |
| --- | --- | --- |
| Fleet service | `compute-control`: hosts' leases, placement, moves, recovery, the API Opengeni calls, optionally the E2B front door | `ghcr.io/cloudgeni-ai/opengeni-compute-control` (`docker/control.Dockerfile`), run by the Opengeni Helm chart's `computeControl` |
| Hosts | `compute-host` and its guard on Linux machines with KVM, archiving to object storage | the host bundle `compute-host-<version>-x86_64-linux.tar.gz` (`deploy/host`), installed by its `install.sh`; on GCP by `deploy/terraform/gcp-compute` |
| Opengeni | the `compute` sandbox backend, selected per deployment or session | Opengeni's own images and chart |

Releases come from `.github/workflows/compute-release.yml`: every push to
main that touches `compute/` pushes the image as `sha-<commit>` and `main`
and keeps the host bundle as a workflow artifact; a `compute-v<version>`
tag (equal to `compute/Cargo.toml`'s workspace version) also tags the image
`<version>` and publishes the bundle, its `SHA256SUMS` and build provenance
as a GitHub Release. Verify either with `gh attestation verify`. The bundle
is built twice from two paths and must come out byte for byte the same.

### The fleet service

Enable `computeControl` in the Opengeni chart. It is off by default, and
enabling it changes no session's backend.

1. **Its database.** It keeps its state in its own schema and login role
   in Opengeni's Postgres (`computeControl.database`, role and schema
   `compute`). With `database.provision` (the default) a hook Job creates
   the role with the password from `database.existingSecret`, sets its
   search path to the schema, creates the schema it owns and grants it
   `connect`, using the migration owner URL; nothing of Opengeni's is
   granted to it. Where a DBA owns roles, turn `provision` off and give a
   whole connection string with `database.urlKey`. The service creates its
   tables at start. It also takes two Postgres advisory locks (7231401 for
   its schema, and its leader lock); keep them free in a shared database.
2. **Its keys.** API keys are `team key` lines in a Secret
   (`computeControl.keys.existingSecret`, entry `keys`); the service
   stores their digests at every start. Make one key for Opengeni's team
   and one for the operator team (`computeControl.operatorTeam`, default
   `operator`), which alone may list, drain and undrain hosts:

   ```sh
   opengeni_key=$(openssl rand -hex 32); operator_key=$(openssl rand -hex 32)
   kubectl create secret generic compute-keys \
     --from-literal=keys="opengeni $opengeni_key
   operator $operator_key"
   ```

   Put the same `opengeni` key in Opengeni's runtime Secret as
   `OPENGENI_COMPUTE_API_KEY`, and keep the operator key in the operators'
   secret store.
3. **TLS with the hosts.** The service and its hosts authenticate each
   other: one Secret (`computeControl.hostsTls.secretName`) holds the
   service's certificate and key for the name hosts dial (`tls.crt`,
   `tls.key`) and the authority that signs host certificates (`ca.crt`).
   Hosts trust the authority that signed the service's certificate. The
   GCP root issues both from one private authority and prints them as
   outputs (`fleet_ca_pem`, `control_certificate_pem`,
   `control_private_key_pem`).
4. **Where hosts reach it.** `computeControl.hostsService` exposes port
   8443 outside the cluster: an internal `LoadBalancer` (with the cloud's
   annotation) or a `NodePort`. The certificate must name the address
   hosts dial.
5. **HTTPS for the API.** Opengeni sends its key to the API and refuses
   plain HTTP outside local development. Give the service a certificate
   for the name Opengeni calls (`computeControl.apiTls.secretName`:
   `tls.crt`, `tls.key` and the `ca.crt` that signed them; the name is
   `apiTls.host`, by default `<release>-compute-control.<namespace>.svc`).
   The chart then serves the API with it (`--api-tls-cert`,
   `--api-tls-key`), points `OPENGENI_COMPUTE_API_URL` at
   `https://<host>:8080`, and has Opengeni's API and workers trust
   `ca.crt` (`NODE_EXTRA_CA_CERTS`). A cert-manager `Certificate` from a
   cluster issuer is the usual source.
6. **Agent links** ([ADR 21](adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md),
   [agent links](agent-link.md)). Each host keeps one link to its team's
   agent gateway, the Opengeni API's public WSS endpoint, with a token the
   service signs. Make the signing key once and keep it only in a Secret:

   ```sh
   openssl genpkey -algorithm ed25519 -out link.pem
   kubectl create secret generic compute-link --from-file=link.pem
   ```

   and name it and each team's gateway in the values
   (`computeControl.link.existingSecret`, `computeControl.teamLinks`).
   Opengeni's gateway fetches the public keys from the API
   (`GET /v1/link/keys`).
7. **Archive and group.** `computeControl.archive` is the hosts' store
   (`gs://bucket/prefix`); `computeControl.gcpGroup` the hosts' managed
   instance group, which the service resizes and whose instances it
   fences. Both use the pod's cloud identity: on GKE, bind
   `computeControl.serviceAccount` to the `control_service_account` output
   with Workload Identity (`iam.gke.io/gcp-service-account` annotation and
   `control_workload_identity` in Terraform).
8. **Images.** Sandboxes start from stored images
   (`computeControl.storedImages`, `name: <image id>`). Build each with
   `compute-host build-image <oci-ref> --guest <bundle>/guest --output
   image.ext4 --store gs://bucket/prefix` on any host (or a build machine
   with the bundle), which prints the image id; the Opengeni sandbox and
   desktop images (with `opengeni-agent`, ADR 21) are built this way from
   the same Opengeni commit as the deployment. Hosts fetch an image from
   the store on its first create.

A minimal values file:

```yaml
computeControl:
  enabled: true
  image:
    tag: "0.1.0"
    digest: "sha256:…"
  database:
    existingSecret: compute-database   # COMPUTE_DATABASE_PASSWORD
  keys:
    existingSecret: compute-keys
  hostsTls:
    secretName: compute-hosts-tls      # tls.crt, tls.key, ca.crt
  apiTls:
    secretName: compute-api-tls        # tls.crt, tls.key, ca.crt
  link:
    existingSecret: compute-link       # link.pem
  teamLinks:
    opengeni: wss://opengeni.example.com/v1/compute/agent-link
  hostsService:
    type: LoadBalancer
    annotations:
      networking.gke.io/load-balancer-type: Internal
  archive: gs://example-compute-archive/archive
  gcpGroup: projects/example/zones/europe-west4-a/instanceGroupManagers/opengeni-compute-hosts
  storedImages:
    opengeni: "<image id>"
    opengeni-desktop: "<image id>"
  serviceAccount:
    annotations:
      iam.gke.io/gcp-service-account: opengeni-compute-control@example.iam.gserviceaccount.com
```

The daily sweep of the store (ADR 17) runs as a CronJob from the same
image and identity (`computeControl.sweep`).

### Hosts

On GCP, `deploy/terraform/gcp-compute` makes the whole host side: the
hosts' instance template and zonal managed instance group (nested
virtualization, or bare metal), the archive bucket (uniform access, no
public access, a week of soft delete), the fleet's certificate authority
(CA Service), a host and a control service account with only what each
needs, and the firewall rules (the service to hosts on 7443, hosts to the
service, optional SSH). See its `terraform.tfvars.example`. Each host's
startup script prepares the state volume (local NVMe SSDs, striped, or a
persistent disk), fetches and checks the bundle the template names, gets a
30-day certificate for its instance name and renews it daily, and runs
`install.sh`. Terraform sets the group's first size; the service sizes it
from then on. The group has no auto-healing (the service decides when a
host is lost and fences it), and a new template reaches hosts only as they
are replaced.

Elsewhere, install a host by hand: a systemd Linux machine with KVM, an
XFS state volume, a certificate signed by the fleet's authority for a name
unique in the fleet, and the bundle:

```sh
tar -xzf compute-host-0.1.0-x86_64-linux.tar.gz && cd compute-host-0.1.0-x86_64-linux
cp host.env.example host.env   # fill in the service, name, address, zone, store
install -m 600 host.pem host.key ca.pem -t /etc/compute/
sudo ./install.sh --config host.env --state-device /dev/nvme1n1
```

`install.sh` checks the bundle against `SHA256SUMS`; installs the packages
the agent runs (iproute2, nftables, e2fsprogs, xfsprogs); installs the
release under `/opt/compute/releases/<version>` behind
`/opt/compute/current`; downloads Firecracker, its jailer and the guest
kernel that `pins.env` names, checking each SHA-256; formats and mounts the
state volume at `/var/lib/compute` the first time and records its
filesystem UUID; builds the base image from `COMPUTE_BASE_IMAGE_REF`; and
installs three units:

- `compute-host-setup.service` applies the kernel settings at every boot:
  the huge-page pool (`COMPUTE_HUGE_PAGES`), no transparent huge pages,
  the software watchdog (3 s, `nowayout`) where the machine has no
  hardware one, and no suspend;
- `compute-guard.service`, started once and never restarted: it stops
  every VM when the host's lease runs out, and the watchdog resets the
  machine if the guard itself ends;
- `compute-host.service`, the agent, which checks before every start that
  the mounted state volume is the recorded one and that its certificate,
  Firecracker, kernel and base image are there (`check-host`), and runs
  with `KillMode=process` so a restart leaves its VMs running.

### Opengeni's settings

Opengeni's `compute` backend reads:

| Setting | Value |
| --- | --- |
| `OPENGENI_SANDBOX_BACKEND` | `compute` for a deployment that uses it by default; leave it (default `modal`) to let sessions choose it |
| `OPENGENI_COMPUTE_API_URL` | the service's API; when `computeControl` is enabled the chart sets `https://<apiTls.host>:8080` (plain `http://<release>-compute-control:8080` without `apiTls`, which Opengeni accepts only in local and test environments) |
| `OPENGENI_COMPUTE_API_KEY` | the `opengeni` team's key, in the runtime Secret |
| `OPENGENI_COMPUTE_LINK_URL` | the agent gateway's public `wss://` URL, the audience of the hosts' link tokens, so exactly the service's `--team-link` URL for Opengeni's team; the chart sets it from `computeControl.teamLinks[computeControl.opengeniTeam]` |
| `OPENGENI_COMPUTE_IMAGE`, `OPENGENI_COMPUTE_DESKTOP_IMAGE` | stored image names, as in `computeControl.storedImages` |

The backend also needs `OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true`, the relay
(`OPENGENI_SELFHOSTED_RELAY_URL` and its token secret) and the agent
op-stream (`OPENGENI_AGENT_OP_STREAM_ENABLED`, on by default); Opengeni
refuses to start with `OPENGENI_SANDBOX_BACKEND=compute` while any is missing.

Every sandbox runs Opengeni's agent behind its host's link
([ADR 21](adr/0021-opengeni-runs-natively-its-agent-behind-the-hosts-link.md)),
so the backend also uses Opengeni's agent gateway (in the API, at the
`teamLinks` URL) and its relay. The network needs:

| From | To | Why |
| --- | --- | --- |
| Opengeni's API and workers | the service's API (8080, HTTPS) | create, wake, move, delete |
| the service | hosts (7443, mutual TLS) | the fleet's calls to hosts |
| hosts | the service's hosts endpoint (8443, mutual TLS) | registration, leases, link tokens |
| hosts | Opengeni's public API (443, WSS) | the agent link, which carries the guests' control traffic |
| guests | Opengeni's relay (443, HTTPS/WSS) | terminal, desktop and file streams |
| hosts | object storage | the archive and stored images |

Guests never reach Opengeni's NATS; it stays inside Opengeni's network.
Hosts check the gateway's certificate against the system's authorities;
for a gateway with a certificate of a private authority, give each host
`--agent-link-ca <pem>` in `COMPUTE_HOST_ARGS`, and it trusts that
authority alone for agent links.

## Hosts

- **Adding hosts.** On GCP the service grows the group itself as spare
  memory runs short (`--scale-*` flags); to add one by hand, resize the
  group. A new host registers with the service when its agent starts and
  takes sandboxes at once. A host installed by hand joins the same way.
  List hosts with the operator key:

  ```sh
  curl -s -H "X-API-Key: $operator_key" "$COMPUTE_API/v1/hosts" | jq
  ```

- **Draining a host.** `POST /v1/hosts/<name>/drain` stops new sandboxes
  going there and hands off every sandbox on it that nothing holds awake;
  each is adopted elsewhere on its next wake (ADR 18). The answer counts
  those `moved` and those `left` (held awake, or the host did not answer):
  drain again until none are left, or until those left are let go of by
  their users. `POST /v1/hosts/<name>/undrain` takes the host back.
- **Removing a host.** Drain it to zero, then delete the machine (on GCP,
  `gcloud compute instance-groups managed delete-instances` so the group
  does not replace it). Never delete a host that still owns sandboxes: the
  service would treat it as lost and recover them, which is safe but
  slower than a drain and wakes them from the archive.
- **A lost host.** A host whose lease renewals stop is given up on after
  its term and margin: the service fences it first (on GCP it resets the
  instance, or finds it stopped or gone), then clears its sandboxes'
  owner with a raised epoch, and each wakes on another host from its
  latest archived copy on its next request. Work since that copy is lost,
  which is why sandboxes archive soon after they go idle. Nothing has to
  be done by hand, except replacing the machine where no group does it.
  If the host comes back, its guard has already stopped its VMs (its
  lease ran out), and it registers again; the raised epochs keep it from
  running any sandbox that moved (ADR 18). A host whose fence
  keeps failing is not given up on: alert on hosts in state `lost` for
  more than a few minutes and fence them by hand (stop the machine).

## Keys and certificates

- **API keys.** Add a key by adding its line to the keys Secret and
  restarting the service (`kubectl rollout restart`), or with
  `compute-control add-key --team <team> --database <url>`. The store
  keeps digests only. Removing a line does not remove the key: delete its
  row after the new key is in use: `delete from compute.compute_keys
  where digest = '<digest>'`, the digest being the key's BLAKE3 hash in hex
  (`printf %s "$key" | b3sum`). Callers send keys as `X-API-Key`. To rotate Opengeni's key: add the new one, switch
  `OPENGENI_COMPUTE_API_KEY` and roll Opengeni out, then delete the old
  row.
- **Host certificates** are 30 days, from the fleet's authority, renewed by
  each host's daily timer when fewer than 10 days are left (the agent is
  restarted to use it; its VMs keep running).
- **The service's certificate.** Renew it before it expires
  (`terraform apply -replace='google_privateca_certificate.control[0]'`,
  update the Secret, restart the service). Hosts keep their connection
  until it breaks and dial again.
- **The authority.** To replace it, add the new authority to the pool, let
  hosts renew under it (they trust the pool's certificates, read at each
  renewal), give the service both authorities in `ca.crt`, then retire
  the old one.
- **The database password**: change it in the Secret and upgrade the
  release; the hook Job sets it on the role, and the new pods use it.
- **The link signing key.** Make a new key, add it to the link Secret
  under a new entry, and make the new entry `link.key` and the old one a
  `link.previousKeys` entry: the service signs with the new key and still
  publishes the old one at `/v1/link/keys`, so links opened with tokens
  signed by it stay valid. Once every token signed with the old key has
  expired, drop it from `previousKeys` and the Secret.
- **The API's certificate** comes from its Secret; renew it there and
  restart the service. Opengeni's pods read `ca.crt` at start, so a new
  authority needs a rollout of Opengeni as well.

## Backups

- **The service's database** is small (hosts, sandboxes' owners and
  specs, keys). Back it up with Opengeni's Postgres; the `compute` schema
  is part of the same database. After a restore from an older backup, the
  service's view of owners may be behind the hosts': restart the service,
  and hosts' registrations and the epochs the fence keeps decide (ADR 18).
- **Sandboxes** are their own backup: every idle sandbox reaches the
  archive bucket, which is the copy recovery uses. Keep the bucket's soft
  delete on, and consider turbo replication or a dual-region bucket where
  a regional outage must not lose sandboxes.
- **Hosts** hold nothing that is not in the bucket once their sandboxes
  are archived; do not back them up.

## Security

What isolates a sandbox, and what a human security review must cover
before users move to the fabric from Modal:

- **The VMM.** Every sandbox is a Firecracker microVM started through
  Firecracker's jailer: its own user and group, a chroot, its own cgroup
  and namespaces, seccomp filters, and a pinned Firecracker release
  checked by SHA-256 (`deploy/host/pins.env`). Guests share no kernel with
  the host or each other.
- **The network.** Each sandbox has its own namespace and nftables rules:
  internet through NAT, nothing else; no host, no other sandbox, no
  private or shared ranges, no metadata service
  ([ADR 11](adr/0011-fixed-guest-network.md)). The production units do
  not pass `--trusted`.
- **Hosts.** Hosts hold their sandboxes' disks and memory, encrypted at
  rest by the provider, and the host account can read and write every
  archived sandbox in the bucket. A host is as trusted as every sandbox
  in the fleet; run hosts in a project of their own, with no other
  workloads, OS Login and no SSH from the internet.
- **Host identity.** Hosts and the service authenticate each other with
  certificates from the fleet's authority. On GCP any instance running as
  the host account can ask for a certificate of any host name, so a host
  compromised to root can impersonate another host to the service. The
  intended fix is for the service to issue host certificates itself
  against the instance's identity token; until then, treat the host
  account as one trust domain.
- **The service.** It holds the Opengeni and operator keys' digests, the
  host group's permissions (resize, reset, stop, start) and the bucket's
  objects. Opengeni reaches it inside the cluster; only the host endpoint
  is exposed, with mutual TLS.
- **Sharing between customers.** Identical chunks are shared within a
  store prefix (see Capacity and cost).
- **What the review must check**, in order of risk:
  1. the jailer's configuration as the agent builds it (user per VM,
     chroot contents, seccomp level, cgroup limits on the VMM, no device
     files beyond KVM, the TAP device and the vsock);
  2. the per-sandbox nftables rules on a running host, from inside a
     guest: host addresses, the metadata address, other sandboxes, the
     VPC, IPv6, and the cloud's public-to-private mapping (`--block`);
  3. the guest-to-host channels, whose input from guests is untrusted:
     the vsock ports the host serves (guest ports it forwards, and the
     agent link of ADR 21) and the pagers' and gateway's replies;
  4. the memory pagers (userfaultfd) and the store's checksums, which
     keep one sandbox's memory from another's and from tampering in the
     bucket;
  5. host identity as above, the bucket's IAM, and the service's keys;
  6. the host image: kernel version and its KVM mitigations, SMT, and
     that the hosts' project runs nothing else.

  Until it is done, keep Modal the default and the fabric opt-in.

## Storage

- **Mount the state volume before the agent starts.** The agent creates its
  state root if the parent directory exists, so an unmounted volume looks
  like an empty host and the agent would start keeping new records on the
  wrong filesystem. Configure the volume's mount, start the agent from a
  systemd unit with `RequiresMountsFor=<state root>` so it starts after
  that mount, and check that the intended volume is there:
  `AssertPathIsMountPoint=` on the volume's mount point, and an
  `ExecStartPre=` that compares the mounted filesystem's UUID with the one
  recorded when the volume was set up. Ordering alone does not prove which
  volume occupies the path.
- **Archives must go off the host.** `--store` takes a directory or object
  storage. A directory is for tests and single machines: the agent warns at
  start, and an archive there is lost with the host. Production hosts use
  `gs://`, `az://` or `s3://`.
- **Size state volumes for what is placed on them.** The agent books local
  disk before anything writes: saves, guest disk growth, wakes from object
  storage, new sandboxes' first files, ready-sandbox fills and template
  builds ([ADR 14](adr/0014-requests-limits-and-admission.md)). What it
  cannot book waits or is refused with `host_full`, so a volume too small
  for its sandboxes shows as refused wakes and creates, not as lost data.
  Bookings are worst cases (a disk's full length less what it holds
  alone), so a host of many large, mostly empty disks fits fewer sandboxes
  than its free space suggests. Writes outside the agent (logs, other
  programs on the volume) are not booked: keep `--disk-reserve-mib` above
  them and alert on free space early, for example below 20 %.
- **Encryption is the volume's and the store's.** Chunks are stored raw or
  compressed, not encrypted by us, and a host's state volume holds disks and
  memory images. Check that every state volume and the bucket are encrypted
  at rest by their provider. GCP encrypts local SSDs; on Azure, managed-disk
  encryption does not cover temporary disks, so turn on encryption at host
  there. We do not add our own per-tenant encryption.

## Deleting

- **Deleting a sandbox: its pointer goes last, its bytes later.** Removal
  records the intent, stops the VM, removes its network and then deletes
  the pointer in object storage; a step that fails is tried again, and the
  sandbox shows as removing (or blocked) until all are done. A daily sweep
  (`compute-host sweep --store ... --delete`) then deletes the chunks and
  manifests no pointer names that were stored more than about a week
  before it began ([ADR 17](adr/0017-sweeping-unnamed-chunks.md)). Age
  counts from when an object was last stored, so a copy archived long ago
  goes at the first sweep after nothing names it. A chunk another sandbox
  still names stays: identical content is shared.
- **Forgotten memory images** (30 days after last use by default) lose
  their pointer entry together with their working-set pack, and their
  chunks go at a following sweep under the same rule.
- **Only GCS sweeps delete.** A sweep that deletes needs deletes on
  condition, which we use on GCS; on Azure and S3 it refuses and only
  reports, so unnamed chunks stay there until conditional deletes are
  built for those stores. Deleting a pointer there leaves an empty one,
  which reads as no copy.
- **Provider retention comes on top.** GCS soft delete keeps deleted
  objects 7 days by default; set the bucket's policy to what we promise.
- **Quarantined objects** (stored copies that failed their checksum, kept
  for inspection under `quarantine/v1/`) are not swept. Give that prefix a
  lifecycle rule, for example deletion after 30 days.
- **Watch the sweep.** It stops before deleting anything when a pointer or
  manifest cannot be read, by design: deleting around an unreadable entry
  could take chunks it names. Alert when no sweep has succeeded for two
  days; its error names the key that stopped it.

## Observing

What the agent reports is in [ADR 16](adr/0016-observability.md).

- **Run a collector next to each host.** Pass `--otlp-endpoint
  http://127.0.0.1:4318` to send events as OTLP log records and metrics
  every ten seconds (`--otlp-metrics-every`); add `--otlp-header
  name=value` for a remote collector that needs a token. Without it,
  events go only to the agent's log, one JSON line each under the
  `compute_event` target, which the journal keeps. `--no-journal-events`
  turns that copy off once a collector takes them.
- **Run the canary** with `--canary-every 5m` and, if the guest image
  serves a port, `--canary-port`. It costs one 128 MiB sandbox kept awake
  and one created and removed per round, and a little store traffic. Its
  two sandboxes show in status like any other; their ids start with
  `ca4a79`, then 64 bits the host made up at random the first time and
  keeps in `canary-id` in its state root, so hosts sharing a store never
  touch each other's canary.
- **Alert on these:**
  - any increase of `compute.alarm.count`. Each occurrence also writes a
    `compute.alarm` event naming the sandbox (or the stored object's key),
    so group alerts on that.
  - `compute.canary.count` with outcome `failed` or `timed_out`, and a
    `compute.canary.last_run` older than one rotation plus a period for
    any path, which also catches an agent that died or hangs. A rotation
    is four periods (three on a host without a store), since each run
    takes the next path, so with `--canary-every 5m` that is 25 minutes.
  - `compute.sample.age` above a minute: the agent's loop is stuck.
  - `compute.step.oldest_age` above the step's usual time, for example
    ten minutes for an archive.
  - `compute.sandbox.unhealthy` above zero: sandboxes broken, blocked or
    unsavable need a person.
  - any increase of `compute.export.dropped`: the collector is slow, away
    or refusing; events are still in the journal.
- **Find a slow sandbox** by querying `compute.step` and `compute.request`
  events for its `compute.sandbox.id`. Steps carry time per phase, bytes,
  cause and the host-side pressure the sandbox saw since its previous
  event. A caller that sends `traceparent` finds them under its own trace.

## Upgrades

- **The agent** can be replaced at any time; running VMs keep running
  ([ADR 9](adr/0009-vms-outlive-the-agent.md)). Run the new bundle's
  `install.sh` (without `--config`, the installed configuration stays):
  it installs the release beside the old ones, points
  `/opt/compute/current` at it and restarts the agent alone; the guard is
  never restarted. Old releases stay under `/opt/compute/releases`;
  remove one once no pager runs from it (`fuser
  /opt/compute/releases/<version>/compute-host`). On GCP, set the new
  bundle in Terraform and replace hosts one at a time, each drained first,
  or run `install.sh` from the new bundle on each host in place.
- **The fleet service** is a Deployment: upgrade the chart with the new
  image. Replicas share the store; one leads at a time, and a new leader
  waits a whole lease term before giving up on any host, so a rollout
  never loses hosts.
- **Firecracker**: a wake uses whichever configured Firecracker (the
  current one or one kept with `--retained-firecracker`) reads the image's
  snapshot format on the image's CPU, so a newer compatible release
  restores older images and runs them from then on. Keep the previous
  binary only when a release changes the snapshot format, until no saved
  image needs it. Status shows the runtime the agent launches new VMs
  under, not the runtime of every saved image; each image records its own.
- **The host kernel**: Firecracker does not promise that a memory image
  restores under another host kernel. Before rolling a new host image out,
  save sandboxes on the old one and wake them on the new one (with the
  `save_wake` and `lab` tests and a store both hosts share), and keep the
  old image to roll back to.
- **The guest kernel** a VM booted with stays through every save and wake;
  only a fresh boot picks up a new one. A sandbox's own disk then boots
  with the newest kernel, so a new guest kernel must be tested against the
  root filesystems still in use. We never replace a user's disk to upgrade
  it.
- **Security patches.** A sandbox runs a patched Firecracker only once its
  VMM process is replaced: when it wakes from a saved image (Saved,
  Archived or Remote). One that resumes from Paused or Compressed resumes
  the same process, and one that stays busy keeps it. A restore prefers
  the binary that made the image while it is kept with
  `--retained-firecracker`, so drop a vulnerable binary from that list
  first; the current binary then restores every image whose snapshot
  format it reads. To move a sandbox off a vulnerable VMM now, sleep it to
  `saved` (the `Sleep` request), wait until status shows it saved (the
  request answers at once, holds delay it and a wake cancels it), then
  wake it. A guest kernel fix needs a
  fresh boot, which means stopping affected sandboxes (they boot fresh
  from their disks). There is no live patching.

## Emergencies

- **Stopping a sandbox when the state disk is read-only.** Removal writes
  its intent first and refuses when it cannot. To contain a sandbox anyway,
  kill its VM directly: `echo 1 > /sys/fs/cgroup/compute/<sandbox id>/cgroup.kill`
  (the path under `--cgroup`). Its files stay and the agent treats
  the VM's end like a crash. Remove the sandbox through the API once the
  disk is writable again.

## Network

- Sandboxes cannot reach the host, other sandboxes, private ranges or the
  metadata address ([ADR 11](adr/0011-fixed-guest-network.md)). Where the
  cloud maps a public address onto the host, the host can also be reached
  through that address: pass it with `--block`, and check from a guest that
  it is refused.

## Capacity and cost

- **Nested hosts need their huge-page pool reserved** (`vm.nr_hugepages`,
  or `hugepages=` on the kernel command line so it is reserved before
  memory fragments). Pages in the pool serve only guests, so size it to the
  guest memory meant to be resident at once, ready pool included, and leave
  the rest to the host: page cache, pagers and the agent. The agent refuses
  to start the nested profile without a pool. On cgroup v2 without the
  `memory_hugetlb_accounting` mount option, a VM's huge pages do not show in
  its `memory.current`.
- **Sleeping sandboxes are not free on the host.** Each record keeps a
  network namespace and its guest-port listeners even when its memory and
  disk live only in object storage. The final measurements report agent
  memory and open files per archived sandbox; placement must count records,
  not only running VMs.
- **The agent's processors come out of the sandboxes'.** The agent runs a
  quarter of the host's processors, from 2 to 8, as async workers, and
  compresses as many chunks at once for object storage; blocking threads,
  which mostly wait on local disk, are 64 more than that. Archiving is the
  agent's only long processor-bound work, so `--compress-threads` sets how
  fast idle sandboxes reach object storage against how much processor
  time their neighbours lose (see the agent threads measurement in
  [measurements](measurements.md)). Raise it where saved sandboxes wait
  long for their archive and local disk runs short; `--worker-threads` and
  `--blocking-threads` rarely need changing.
- **Busy is busy.** A sandbox that keeps computing stays awake, whether it
  builds code or mines coins. Sleep policy does not decide who pays: usage
  for billing and account budgets belongs to the layer above.
- **Sharing between customers.** Identical chunks are shared within a store
  prefix. Give each sharing domain (one customer, or one trust zone) its own
  prefix, chosen by the control plane; a host whose sandboxes span domains
  needs one store per domain, which is not built yet.

## Testing

Four layers, each a superset of what the one before cannot reach:

| Layer | Where | What | When |
| --- | --- | --- | --- |
| CI | `.github/workflows/compute-ci.yml` on GitHub-hosted runners | rustfmt; clippy with the workspace's pedantic lints as errors; the structure rules (`cargo arch`, comparing the baseline with the base commit's); every test that needs no KVM: unit, the seeded simulations of the core and the fleet protocol, property and crash-boundary tests, the fleet store against Postgres, checkpoints on XFS, and the smoke framework's own tests | every pull request and push to main that touches `compute/` |
| KVM gate | the same workflow's `kvm` job | `ci/gate.sh` with real Firecracker VMs on the runner's KVM: the pager's kernel tests, the per-sandbox network, the engine, save and wake through an agent restart, many sandboxes through an agent kill, real images with our init, the smoke suite and the E2B conformance suite, on the nested profile | the same |
| Lab gate | any Linux machine with KVM, prepared by `lab/host-setup.sh` | `ci/gate.sh` with every step, on bare metal or nested, with an object store (`STORE=gs://…`) | before a merge that changes the engine, the store or the fleet |
| End to end | GCP, `e2e/` | a real Opengeni stack with the `compute` backend, the fleet service and three hosts; real agent sessions with a real model (below) | before a release, and on demand |

GitHub's hosted x64 Linux runners are VMs with nested virtualization that
expose `/dev/kvm` (root, group `kvm`, mode 0660); the job grants the runner
user access with an ACL, makes an XFS lab directory on a loop file,
reserves a quarter of the runner's memory as huge pages for the nested
profile, and caches the downloaded Firecracker, kernel and base image by
the pins' hash. It runs four sandboxes where the lab gate runs twelve.

Run the gate on a lab host:

```sh
bash lab/host-setup.sh                       # once
PROFILE=nested bash ci/gate.sh               # all steps
STEPS="engine save_wake" STORE=gs://bucket/gate bash ci/gate.sh
```

It ends with `GATE_PASSED` or `GATE_FAILED` and the failed steps. KVM
steps set `COMPUTE_TEST_REQUIRE`, so a test that would skip for want of
the lab, the store or the guest fails instead.
