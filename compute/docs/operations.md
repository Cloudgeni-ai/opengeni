# Operations

How to deploy and run Opengeni compute in production, and what an operator
must set up, check and know that the code cannot enforce alone. Each point
says what compute does, what is left to the deployment, and what we
chose not to build.

- [Deploying](#deploying): the control service, the hosts, and Opengeni's
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
| Control service | `compute-control`: hosts' leases, placement, moves, recovery, the API Opengeni calls, optionally the E2B front door | `ghcr.io/cloudgeni-ai/opengeni-compute-control` (`docker/control.Dockerfile`), run by the Opengeni Helm chart's `computeControl` |
| Hosts | `compute-host` and its guard on Linux machines with KVM, archiving to object storage | the host bundle `compute-host-<version>-x86_64-linux.tar.gz` (`deploy/host`), installed by its `install.sh`; on GCP by `deploy/terraform/gcp-compute` |
| Opengeni | the `compute` sandbox backend, selected per deployment or session | Opengeni's own images and chart |

Releases come from `.github/workflows/compute-release.yml`: every push to
main that touches `compute/` pushes the image as `sha-<commit>` and `main`
and keeps the host bundle as a workflow artifact; a `compute-v<version>`
tag (equal to `compute/Cargo.toml`'s workspace version) also tags the image
`<version>` and publishes the bundle, its `SHA256SUMS` and build provenance
as a GitHub Release. Verify either with `gh attestation verify`. The bundle
is built twice from two paths and must come out byte for byte the same.

### The control service

Enable `computeControl` in the Opengeni chart. It is off by default, and
enabling it changes no session's backend.

1. **Its database.** It keeps its state in its own schema and login role
   in Opengeni's Postgres (`computeControl.database`, role and schema
   `compute`). With `database.provision` (the default, for the chart's
   own Postgres only) a Job creates the role with the password from
   `database.existingSecret`, sets its search path to the schema, creates
   the schema it owns and grants it `connect`, using the migration owner
   URL; nothing of Opengeni's is granted to it. The Job is an ordinary
   part of the release, never a hook, so it is applied together with what
   it needs (the chart's Postgres and, under `networkPolicy`, the rule
   that admits it), on an install and on the upgrade that first enables
   the service alike, and the service's pods wait for it, so `--wait`
   completes. Its name follows its inputs: an upgrade that changes none of
   them leaves it alone, and one that does runs a new Job.
   For any other database (`database.host`, required
   when the chart runs no Postgres, or a whole connection string in
   `database.urlKey`), turn `provision` off and have its owner run the
   same statements:

   ```sql
   create role compute login password '…';
   alter role compute set search_path = compute;
   create schema if not exists compute authorization compute;
   grant connect on database <database> to compute;
   ```

   The password reaches the service in a variable of its own, so it needs
   no quoting. The service creates its tables at start and upgrades them
   in place, recording their version. It also takes two Postgres advisory
   locks (7231401 for its schema, and its leader lock); keep them free in
   a shared database.
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
   other with certificates of one authority, the hosts' authority, and the
   service is that authority: one Secret
   (`computeControl.hostsTls.secretName`) holds its certificate (`ca.crt`)
   and key (`ca.key`, PKCS#8). The GCP root makes it (outputs
   `host_authority_pem` and `host_authority_key_pem`); elsewhere
   `compute-control new-host-authority --out <dir>` does:

   ```sh
   umask 077   # ca.key is the trust root: readable by you alone
   terraform output -raw host_authority_pem > ca.crt
   terraform output -raw host_authority_key_pem > ca.key
   kubectl create secret generic compute-hosts-tls --from-file=ca.crt --from-file=ca.key
   ```

   The service issues itself a week's certificate from it, for the host
   of `computeControl.hostUrl` (and `hostsTls.extraNames`), and a new one
   every day, in memory, with no restart. Hosts trust the authority alone
   and get their own certificates from the service (see Hosts). On GCP set
   `computeControl.hostIdentity` to the `identity_tokens` output: the
   project and service account whose instances may prove themselves hosts.
4. **Where hosts reach it.** `computeControl.hostsService` exposes port
   8443 outside the cluster: an internal `LoadBalancer` (with the cloud's
   annotation) or a `NodePort`. `computeControl.hostUrl` is the URL hosts
   dial, exactly as they are given it (the Terraform root's
   `control_url`): the service's certificate is for its host, and hosts'
   identity tokens are for the URL.
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
   `control_workload_identity` in Terraform). A service that runs off
   Google Cloud uses a key of that account instead (`gcloud iam
   service-accounts keys create key.json --iam-account <the output>`,
   where the organisation's policy allows keys): keep it in a Secret,
   mount it through `computeControl.extraVolumes` and
   `extraVolumeMounts`, and name it in `GOOGLE_APPLICATION_CREDENTIALS`
   through `computeControl.extraEnv`. Both the archive and the group take
   it from there; only service account key files are supported. Rotate
   the key as any long-lived credential, and delete it when the service
   moves onto Google Cloud.
8. **Images.** Sandboxes start from stored images
   (`computeControl.storedImages`, `name: <image id>`). Build each with
   `compute-host build-image <oci-ref> --guest <bundle>/guest --output
   image.ext4 --store gs://bucket/prefix` on any host (or a build machine
   with the bundle), which prints the image id; the Opengeni sandbox and
   desktop images (with `opengeni-agent`, ADR 21) are built this way from
   the same Opengeni commit as the deployment. Hosts fetch an image from
   the store on its first create.
9. **Checkpoints.** A running sandbox whose create names no sleep config
   (Opengeni's never does) is checkpointed to the store after every ten
   minutes it runs: losing its host costs it what it did since its newest
   copy (ADR 18). `--checkpoint-every-s` (through
   `computeControl.extraArgs`) sets that target for the fleet; 0 takes
   none.
10. **Metrics.** Set `computeControl.metrics.port` (for example 9464) to
   serve the service's own metrics; `observability.serviceMonitor` and
   `observability.prometheusRule` add their ServiceMonitor and alerts. For
   the hosts' metrics, set `computeControl.metrics.hostsTo` to
   Prometheus's OTLP receiver and add `--otlp-metrics-to-control` to the
   hosts' `host_args` ([Observing](#observing)).

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
  hostUrl: https://compute-control.example.com:8443
  hostsTls:
    secretName: compute-hosts-tls      # ca.crt, ca.key
  hostIdentity:                        # the identity_tokens output
    gcpProject: example
    gcpAccount: opengeni-compute-host@example.iam.gserviceaccount.com
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
image and identity (`computeControl.sweep`). It deletes only from Google
Cloud Storage; with an `az://` or `s3://` archive turn it off
(`sweep.enabled: false`), which the chart requires.

### Hosts

On GCP, `deploy/terraform/gcp-compute` makes the whole host side: the
hosts' instance template and zonal managed instance group (nested
virtualization, or bare metal), the archive bucket (uniform access, no
public access, a week of soft delete), the hosts' authority (a key and
certificate, in Terraform's state; no managed certificate authority), a
host and a control service account with only what each needs, and the
firewall rules (the service to hosts on 7443, hosts to the service,
optional SSH). See its `terraform.tfvars.example`. Each host's startup
script names the hosts' memory profile (`memory_profile`, ADR 5): by
default `nested` on nested-virtualization hosts, where huge pages keep
memory faults cheap but every awake sandbox is booked at its full size,
and `bare-metal` otherwise. `bare-metal` on a nested host books sandboxes
at their request, lets them use more up to their size and adds the
Compressed level, at the cost of slower memory faults. The startup
script prepares the state volume (local NVMe SSDs, striped, or a
persistent disk), fetches and checks the bundle the template names, and
runs `install.sh` with the authority's certificate from the template's
metadata. `install.sh` gets the host its certificate from the service
(`compute-host-certificate`): the host proves its instance name with the
instance's identity token, for `control_url`, and the service issues a
week's certificate for that name; a daily timer renews it when fewer than
four days are left, with a new token, so a host whose certificate expired
gets a new one all the same. Terraform sets the group's first size; the service sizes it
from then on. The group has no auto-healing (the service decides when a
host is lost and fences it), and a new template reaches hosts as they are
replaced, or, when it changes only their metadata (such as the bundle),
as the operator refreshes them to it (Upgrades).

Elsewhere, install a host by hand: a systemd Linux machine with KVM, an
XFS state volume, a name unique among the hosts, and the bundle. With no
identity token to prove its name, the host's first certificate comes from
`compute-control issue-host-certificate`, run where the authority's key is
(the service's Secret); from then on the host renews it with the current
one:

```sh
tar -xzf compute-host-0.1.0-x86_64-linux.tar.gz && cd compute-host-0.1.0-x86_64-linux
cp host.env.example host.env   # fill in the service, name, address, zone, store
sudo ./install.sh --config host.env --authority ca.crt --state-device /dev/nvme1n1
# fails, naming the request it left at /etc/compute/request/host.csr; where ca.key is:
compute-control issue-host-certificate --name compute-host-1 --csr host.csr --authority <dir> > host.pem
# back on the host:
sudo install -m 600 host.pem /etc/compute/request/host.pem && sudo ./install.sh
```

A host whose certificate expired (off for over a week) needs a new one the
same way.

Nothing else on a host may drop forwarded traffic. A packet passes a
firewall hook only if every chain on it accepts it, so another firewall
whose forward chain drops by default, such as Docker's `FORWARD` chain or
ufw's, cuts every sandbox off from everything unless it accepts traffic
from and to the sandboxes' links, `ogc*`. The agent warns when it starts
of each such chain it finds through nftables (it cannot see
iptables-legacy rules). On a host running Docker with its iptables
backend (its default, including over iptables-nft; its nftables backend
has no `DOCKER-USER` chain):

```sh
sudo iptables -I DOCKER-USER -o 'ogc+' -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
sudo iptables -I DOCKER-USER -i 'ogc+' -j ACCEPT
```

These only keep the other firewall from dropping what the agent allows:
the agent's own chain runs first, and what it drops stays dropped.
Docker leaves `DOCKER-USER` alone, but rules added by hand are gone after
a reboot: keep them the way the host keeps its other firewall rules.

`install.sh` checks the bundle against `SHA256SUMS`; installs the packages
the agent runs (iproute2, nftables, e2fsprogs, xfsprogs); installs the
release under `/opt/compute/releases/<version>` behind
`/opt/compute/current`; downloads Firecracker, its jailer and the guest
kernel that `pins.env` names, checking each SHA-256; formats and mounts the
state volume at `/var/lib/compute` the first time and records its
filesystem UUID; builds the base image from `COMPUTE_BASE_IMAGE_REF`; and
installs three units:

- `compute-host-setup.service` applies the kernel settings at every boot:
  the huge-page pool (`COMPUTE_HUGE_PAGES`; when the kernel finds too few
  free 2 MiB runs, as on a fresh host whose memory is page cache from the
  base-image unpack, it drops the cache, compacts memory and asks again,
  and fails only if still short), no transparent huge pages,
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
  A member of the group counts as booting, its memory as coming, for
  `--scale-boot-within-s` (10 minutes by default) without a registered
  host; past that the service logs "a host group member has not
  registered in time" and grows the group around it. Look at that
  instance in the cloud console (quota, a stockout, a boot that fails);
  the service never deletes it, and counts it again once its host
  registers. A stalled member and a draining host each keep their place
  in the group's size, so a growth asks for the hosts it is short on top
  of them, and the service does not suggest shrinking while a member is
  stalled. List hosts with the operator key:

  ```sh
  curl -s -H "X-API-Key: $operator_key" "$COMPUTE_API/v1/hosts" | jq
  ```

  Each host shows its memory and disk, `cpu_millis` (the processor time
  it guarantees at once now) and
  `cpu_free_millis` (what a wake can still reserve). A `cpu_millis` below
  what the host was given means something outside the VMs' group takes
  more of its processors than it keeps back; the agent logs it.

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
  latest archived copy on its next request. It boots from that copy's
  files: its programs end and start afresh, and what it wrote since the
  copy is lost, which is why sandboxes archive soon after they go idle
  and are checkpointed while they run. Its memory is not brought back
  because the lost host may have run it on past the copy (ADR 18); a
  drain or move hands the latest state off, memory and all. The adopting
  host raises the `programs_lost` alarm for each sandbox whose memory it
  set aside, as a host does for a VM that died. Nothing has to be done by
  hand, except replacing the machine where no group does it.
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
- **Host certificates** last a week, from the service
  (`POST /v1/hosts/certificate`), and each host's daily timer
  (`compute-host-certificate.timer`) renews its own when fewer than four
  days are left; the agent is restarted to use it, and its VMs keep
  running. `compute-host-certificate --force` renews at once. The service
  builds every certificate itself: it takes only the public key from the
  host's request and names the host it proved, never a name the request
  asks for, nor the service's own names, nor a name ending in a dot. Each
  certificate records how its name was proven, as its organizational unit:
  `proven by gce-identity` (an instance identity token) or `proven by
  certificate` (a renewal by certificate, or `issue-host-certificate`).
  Only the second kind renews by being presented, and only while it is
  valid at the moment of renewal, whatever connection it came over; a
  certificate a token proved renews only with a fresh token. On a host
  the key and certificate are one unit: each pair is written to its own
  directory under `/etc/compute/certificates/`, the symlink
  `/etc/compute/certificate` is switched to it in one rename, and
  `host.pem` and `host.key` point through it, so an interrupted renewal
  leaves the old pair or the new one. A pair counts as current only if
  the key is the certificate's and the certificate verifies against
  `ca.pem`; runs take a lock. Each run first finishes what an
  interrupted one left: it points `host.pem` and `host.key` through a
  valid published pair they do not both point through yet, and does a
  restart of the agent still owed. `/etc/compute/restart-owed` is written
  before a pair is switched in and removed only once the agent restarted
  (or systemd reported it not running), so a failure after the switch, in
  cleaning up, in asking systemd or in the restart, is made good by the
  next run (the daily timer at the latest). A restart that was tried is
  marked so in that file, and the next run restarts the agent whatever its
  state, since a failed restart may have stopped it; so it also starts an
  agent you stopped in between. To keep an agent stopped while a restart
  is owed, stop `compute-host-certificate.timer` too, or delete
  `/etc/compute/restart-owed` once you have checked that the agent will
  start with the published pair.
- **Google's keys** (for identity tokens) are used only until their
  answer's `Cache-Control` expiry. Past it, only a successful fetch makes
  them usable again, so while Google's keys cannot be fetched no host gets
  a certificate by token: hosts retry (the startup's backoff, the daily
  timer with days to spare), and the outage only delays renewals.
- **The service's certificate** needs nothing: the service issues itself
  one for a week, from the authority, and a new one every day, for both
  ends of its links with hosts. Open links keep the certificate they began
  with.
- **The authority** is ten years' (Terraform's) or as long as you made it.
  Replace it in three steps, each a Secret change and a restart of the
  service (`kubectl rollout restart`); hosts follow, because each renewal
  replaces a host's `ca.pem` with the authorities the service trusts:
  1. Make the new authority (`compute-control new-host-authority`, or with
     Terraform keep the current `host_authority_pem` and
     `host_authority_key_pem`, set `previous_host_authority_pem` to that
     certificate, and `terraform apply
     -replace=tls_private_key.authority`). Put both certificates in
     `ca.crt`, the old one first, with the old key in `ca.key`. The service
     still issues from the old one and now trusts both; new hosts trust
     both. Wait a week, so every host has renewed and trusts the new one.
  2. Put the new certificate first in `ca.crt`, then the old one, with the
     new key in `ca.key`. The service issues from the new one and still
     accepts hosts' certificates from the old. Wait a week, so every host's
     certificate is from the new one.
  3. Leave only the new certificate in `ca.crt`, set
     `previous_host_authority_pem` to empty and apply, and destroy the old
     key.
- **The database password.** Change it in the Secret, set a new
  `computeControl.database.passwordRevision`, a whole number above the
  last, and upgrade the release: the revision runs a new database Job,
  which gives the role the new password, and rolls the pods, which read it
  only at start; each new pod waits at its database init container until
  it can log in with the new password, so the old pods keep serving until
  then. Each Job records its revision on the role (as the role's comment)
  and changes nothing once a Job of a higher revision has run, so a Job
  left running by an earlier, failed upgrade cannot give the role the
  earlier password back. So never lower the revision, and on a new
  installation over an existing database keep the last one. Once the role
  has the new password, the old pods' open connections keep working but
  new ones fail until each is replaced, so do it outside busy hours.
  Without `provision`, change the role's password yourself before the
  upgrade.
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
before users move to compute from Modal:

- **The VMM.** Every sandbox is a Firecracker microVM started through
  Firecracker's jailer: its own user and group, a chroot, its own cgroup
  and namespaces, seccomp filters, and a pinned Firecracker release
  checked by SHA-256 (`deploy/host/pins.env`). Guests share no kernel with
  the host or each other.
- **The network.** Each sandbox has its own namespace and nftables rules:
  internet through NAT, nothing else; no host, no other sandbox, no
  private or shared ranges, no metadata service
  ([ADR 11](adr/0011-fixed-guest-network.md)), but for the exact
  destinations and TCP ports a host lists with `--reach`. Guests resolve
  names through the host's answer at their gateway, which asks public
  name servers and never the host's own; the review should confirm that
  each listed destination is one sandboxes are meant to reach.
- **Hosts.** Hosts hold their sandboxes' disks and memory, encrypted at
  rest by the provider, and the host account can read and write every
  archived sandbox in the bucket. A host is as trusted as every sandbox
  in the fleet; run hosts in a project of their own, with no other
  workloads, OS Login and no SSH from the internet.
- **Host identity.** Hosts and the service authenticate each other with
  certificates of the hosts' authority, which only the service issues. On
  GCP a host proves its instance name with the instance's identity token
  (signed by Google, for the service's URL, of the configured project and
  host service account), and its certificate names that instance only, so
  a host compromised to root cannot get a certificate for another host.
  Instance names are unique in a zone, not across zones: keep each
  project's host names unique (the Terraform root's group does). Anyone
  who can create an instance running as the host account can add a host,
  so grant `iam.serviceAccountUser` on it to no one but the service.
- **Revoking a host.** A GCP host's certificate renews only with a fresh
  identity token, which only that instance's metadata server can give: so
  once the instance is deleted, no new token can be had for it, and its
  certificate and key, even stolen, never renew by themselves. The
  service does not check offline whether an instance still exists,
  though: an identity token the instance was given before (Google's last
  an hour) gets a certificate until the token's `exp` plus the
  verifier's 60 s leeway, as many times as it is presented. So what an
  attacker took from the instance works for at most the token's remaining
  lifetime, plus 60 s, plus the seven days of the last certificate it
  got; with no token taken, until the certificate expires, a week at most. A
  lost instance that comes back (stopped, reset, recreated under its
  name) gets a new one by token. Off GCP, a host renews by presenting its
  certificate, and the service keeps no list of retired hosts: a stolen
  certificate and key of such a host renew themselves for as long as the
  authority trusts them. Removing that host from the fleet does not stop
  them, and neither does the three-step replacement of the authority (Keys
  and certificates), during which they renew like any host's. Only
  replacing the authority at once does: give the service a `ca.crt` and
  `ca.key` of a new authority alone, replace the GCP hosts (`gcloud compute
  instance-groups managed rolling-action replace`; new instances install
  the new authority from their metadata), and on each remaining host off
  GCP put the new `ca.crt` in `/etc/compute/ca.pem` and give it a new
  certificate with `issue-host-certificate`. Every certificate of the old
  authority stops working at once. Keep such hosts' keys as you keep the
  service's.
- **The authority's key** (`ca.key` in the service's Secret, and the
  Terraform state that made it) is the hosts' trust root: whoever holds it
  can act as any host or as the service. Keep it as the service's other
  keys; it never reaches the service's database.
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
     VPC, IPv6, the cloud's public-to-private mapping (`--block`), each
     `--reach` destination's other ports, and the sandbox's name server
     (its gateway's port 53, the one thing in the namespace a guest
     reaches), which parses guests' queries;
  3. the guest-to-host channels, whose input from guests is untrusted:
     the vsock ports the host serves (guest ports it forwards, and the
     agent link of ADR 21) and the pagers' and gateway's replies;
  4. the memory pagers (userfaultfd) and the store's checksums, which
     keep one sandbox's memory from another's and from tampering in the
     bucket;
  5. host identity as above, the bucket's IAM, and the service's keys;
  6. the host image: kernel version and its KVM mitigations, SMT, and
     that the hosts' project runs nothing else.

  Until it is done, keep Modal the default and compute opt-in.

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

- **Metrics in Prometheus.** In a fleet, the control service and its
  hosts report to the Prometheus that Opengeni's chart already feeds
  (`deploy/observability`), with no collector or credentials on the hosts:
  - The control service serves `GET /metrics` on `--metrics-listen`
    (`computeControl.metrics.port`, for example 9464), which the chart's
    ServiceMonitor scrapes. Every replica reports its API requests by route
    and outcome (`compute_control_requests_total`, with their latency),
    whether it leads, and the hosts' metrics it passed on; the leader alone
    reports the fleet as it reads it: each host's state, what it has and
    can still promise for memory, processors and disk, its sandboxes, how
    long ago its lease was renewed, and the host group
    (`compute_fleet_*`).
  - Hosts run with `--otlp-metrics-to-control` (on GCP, in the Terraform
    module's `host_args`) and post their metrics every ten seconds
    to the control service over the same mutual TLS as their lease. The
    service refuses an export whose resource names another host than its
    certificate does (`host.name`, which the host sets to its name in the
    fleet), and passes on only the metrics hosts send (the list in
    `compute-protocol`'s `host_metrics`): each with its kind, cumulative
    counters, exactly its labels with their listed values, plain values
    and the shared histogram bounds, under the host's own name and with
    no resource attributes but the service's name and the host's. A host
    cannot pass off the control service's or the fleet's series, another
    host's, or labels of its own, and cannot add series by varying what it
    says about itself: its zone, memory profile and CPU template come from
    its registration, on the leader's `compute_fleet_host_info`. Data
    points left out are answered as an OTLP partial
    success and counted in
    `compute_control_host_metric_points_left_out_total`. It passes them on to `--host-metrics-to`
    (`computeControl.metrics.hostsTo`): Prometheus's OTLP receiver,
    `/api/v1/otlp/v1/metrics`, which `deploy/observability`'s
    `values.compute.yaml` turns on with `host.name` promoted to the
    `host_name` label. Events stay in the host's journal.
  - The chart's PrometheusRule alerts on both (with
    `observability.prometheusRule.enabled`), scoping each host to its
    release through the leader's `compute_fleet_host_info`, and the
    **Opengeni · Compute** dashboard shows them.
- **Run a collector next to each host.** Pass `--otlp-endpoint
  http://127.0.0.1:4318` to send events as OTLP log records and metrics
  every ten seconds (`--otlp-metrics-every`); add `--otlp-header
  name=value` for a remote collector that needs a token. Without it,
  events go only to the agent's log, one JSON line each under the
  `compute_event` target, which the journal keeps. `--no-journal-events`
  turns that copy off once a collector takes them. With
  `--otlp-metrics-to-control` as well, only events go to the collector.
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
- **Find what woke a sandbox**: a wake step a caller asked for carries
  `compute.wake.by`: `fleet` (a wake, touch, hold or connection through
  the fleet), `agent_link` (a request for its agent, a message with a
  reply subject; acknowledgements and other messages nobody waits on never
  wake one) or `guest_port` (data for the guest on a port that wakes it).

## Upgrades

- **Order.** Upgrade every host before the control service. Hosts refuse
  requests they do not know, and fields they do not know in the
  service's answers to registration and lease renewal, its rulings and
  sleep settings; they ignore other unknown fields of a request they
  know.
  So a newer service could send an older host something it refuses, or
  a setting it silently ignores. The service ignores what it does not
  know in a host's description and capacity, so newer hosts work with
  the older service meanwhile.
  A release that lets hosts leave out something they used to send, which
  an older service would refuse, says so, and then the service goes
  first.
- **The agent** can be replaced at any time; running VMs keep running
  ([ADR 9](adr/0009-vms-outlive-the-agent.md)), and a host in a fleet
  keeps its lease however many sandboxes it has: the old agent renews
  the lease until its process exits and the new one from the moment its
  process starts, while it takes its sandboxes back; until it has, it
  refuses requests as unavailable, so the service places elsewhere
  meanwhile
  ([ADR 18](adr/0018-the-control-service-leases-and-fences.md)). Its log
  lines `templates found`, `recovered` and `started` tell how long that
  took and where. Template inputs' hashes are kept under
  `templates/inputs/`, so a restart reads none of the large files the
  templates depend on, such as the base image, unless they changed. Run
  the new bundle's `install.sh` (without `--config`, the installed
  configuration stays):
  it installs the release beside the old ones, points
  `/opt/compute/current` at it and restarts the agent alone; the guard is
  never restarted. Old releases stay under `/opt/compute/releases`;
  remove one once no pager runs from it (`fuser
  /opt/compute/releases/<version>/compute-host`). On GCP, set the new
  bundle in Terraform and apply it, so hosts created from then on install
  it. Then replace the hosts one at a time, each drained first, or upgrade
  each in place. A running host keeps the metadata of the template it was
  made from, and its startup script installs the bundle that metadata
  names at every boot, so first move it to the new template:
  `gcloud compute instance-groups managed update-instances <group>
  --instances <host> --minimal-action refresh
  --most-disruptive-allowed-action refresh` changes only its metadata,
  without restarting it, and refuses a template that would need the
  machine restarted (such as a new machine type: replace those hosts).
  Then run `install.sh` from the new bundle on it. A host upgraded in
  place without the refresh goes back to its old bundle when it reboots.
- **The control service** is a Deployment: upgrade the chart with the new
  image. Replicas share the store; one leads at a time, and a new leader
  waits a whole lease term before giving up on any host, so a rollout
  never loses hosts.
  Its schema has versions (table `compute_schema`): each replica, as it
  starts, applies the versions it knows and the database lacks, in order,
  in one transaction under an advisory lock, so two starting replicas
  never both migrate. A released version is never changed; a schema change
  is a new version that keeps what the previous release reads, so old
  replicas keep working beside new ones during a rollout, and a rollback
  to the previous image starts (it logs that the schema is newer than it
  knows).
  The answer to a host's registration is stored (`compute_hosts.answer`)
  and read back by whichever replica sees that attempt again, so it is
  part of the schema too: a release adds to a ruling only what the
  previous release's decoder accepts.
  Back up the schema before an upgrade that adds a version.
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
- **Private destinations sandboxes need.** Where sandboxes must reach
  something only a private or overlay network serves, such as an
  Opengeni whose API, object storage and relay are private, list each
  one with the ports needed: `--reach api.internal:443,9443,9445` in
  `COMPUTE_HOST_ARGS` (the GCP root's `host_args`), repeated per
  destination. A name is resolved by the host when its agent starts, so
  the host's own resolver must know it, and the sandboxes' name server
  answers it with those addresses; restart the agent if it moves.
  Nothing else on the network opens, and the agent refuses an entry in a
  range sandboxes may never reach. `--dns` names the upstream name
  servers the host asks for everything else (1.1.1.1 and 8.8.8.8 by
  default); keep them public, as sandboxes can look up whatever they
  know.
- **Hosts on an overlay network.** Where the control service and Opengeni
  are reached only over an overlay network (a WireGuard mesh such as
  Tailscale), the GCP root joins hosts to it at boot with
  `host_startup_prelude`, a script run before anything else on every
  attempt, and `advertise_interface` (such as `tailscale0`) makes each host
  give the service that interface's address to dial. Keep the join key in
  Secret Manager and list it in `host_readable_secrets` rather than in the
  prelude, which is instance metadata. Overlay addresses in the shared
  range (100.64.0.0/10) are blocked to sandboxes like any local network,
  but for what `--reach` lists, and the overlay's name server is never
  asked for them; do not accept routes or use an exit node on hosts, and
  give hosts an overlay identity that may reach only the service's host
  endpoint and Opengeni's endpoints.
- **A control service in another cloud.** Where the control service runs
  outside the hosts' network with no private path to it, such as in an
  Opengeni cluster on another cloud, both directions go over public
  addresses, still mutual TLS of the hosts' authority alone: the GCP
  root's `assign_external_ip` and `advertise_public_address` make each
  host give the service its public address, `control_source_ranges`
  admits only the service's egress addresses to port 7443, and
  `computeControl.hostsService` is a public `LoadBalancer` on a static
  address whose name `hostUrl` gives. Hosts' public addresses change as
  hosts are replaced, so the hosts endpoint takes connections from
  anywhere: a caller without a certificate of the hosts' authority is
  refused by every route but the one that issues a first certificate,
  and that one needs an identity token of the configured project and host
  account. A host's public address carries its traffic to the internet,
  sandboxes' included, and the startup script blocks it to sandboxes
  (`--block`).

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
- **The agent's processors come out of the headroom.** The agent runs a
  quarter of the host's processors, from 2 to 8, as async workers, and
  compresses as many chunks at once for object storage; blocking threads,
  which mostly wait on local disk, are 64 more than that. Archiving is the
  agent's only long processor-bound work. Sandboxes' requests are
  guaranteed first: when every processor is busy, the agent and the rest
  of the host share `--cpu-headroom-millis` (a sixteenth of the
  processors, at least 500), and archiving then takes longer; a waking
  sandbox's pager runs in its own VM's group, on its request. Otherwise
  `--compress-threads` sets how fast idle sandboxes reach object storage
  against how much idle processor time their neighbours could have used
  (see the agent threads measurement in [measurements](measurements.md)).
  Raise it, or the headroom, where saved sandboxes wait long for their
  archive and local disk runs short; `--worker-threads` and
  `--blocking-threads` rarely need changing.
- **Busy is busy.** A sandbox that keeps computing stays awake, whether it
  builds code or mines coins. Sleep policy does not decide who pays: usage
  for billing and account budgets belongs to the layer above.
- **Certificates cost nothing.** The hosts' authority is a key the service
  holds; no managed certificate authority is billed.
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
| End to end | GCP, `e2e/` | a real Opengeni stack with the `compute` backend, the control service and three hosts; real agent sessions with a real model (below) | before a release, and on demand |

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
