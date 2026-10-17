# Comparison benchmark harness

The client that drives the comparison in `docs/benchmark.md`. It runs on a
client VM of its own, in the same zone as the systems it measures, with
[Bun](https://bun.sh). Results go to JSON-lines files, one record per
sample, step or search, each with the system's own description (versions,
shape, flags).

## Files

| File | What it does |
| --- | --- |
| `bench.ts` | Command line: `latency`, `rate`, `summarize`, `cleanup` |
| `run.sh` | Suites of `bench.ts` runs, one results file per operation |
| `system.ts` | The interface every system implements, and the workload scripts |
| `ours.ts` | This fabric through the host agent's JSON protocol |
| `gke.ts`, `kube.ts` | Agent Sandbox on GKE through the Kubernetes API and the sandbox router |
| `e2b.ts` | E2B cloud, or our E2B-compatible front door, through the E2B SDK |
| `load.ts`, `search.ts`, `stats.ts` | Open-loop Poisson load, the sustained-rate search, nearest-rank percentiles |
| `host-agent.sh` | Restarts the host agent on a lab host as `cold`, `template` or `pool` |
| `relay.ts` | Relays the client's TCP connection to the agent's Unix socket |
| `gke/` | The GKE side: image build, sandbox template and warm pools, snapshots, client account, router |

`bun test` runs the unit tests (statistics, load generation, the rate
search, the agent protocol framing).

## Our fabric

On a lab host prepared by `../host-setup.sh`, as root:

```sh
STORE=gs://BUCKET/agent LISTEN=HOST_IP:7000 CLIENT=CLIENT_IP HUGE_PAGES=24576 \
  BIN=/lab/bin/compute-host bash host-agent.sh pool
```

`STORE` is the object storage for the archived and remote levels, `LISTEN`
the relay's address on the host, `CLIENT` the only address it accepts.
Restart in `cold` or `template` mode for those create measurements. Copy
the binary under test somewhere fixed (`/lab/bin`) so a later build does
not change it mid-run. On the client: `COMPARE_OURS_ADDRESS=tcp:HOST_IP:7000`.

## Agent Sandbox on GKE

A Standard cluster with the managed Agent Sandbox and Pod Snapshot add-ons,
workload identity, and a gVisor node pool of the same machine type as our
host. Then:

1. Build the image from the lab guest's files: `gke/image.sh ROOTFS_TAR IMAGE`.
2. Put the image digest in `gke/sandbox.yaml` and the snapshot bucket in
   `gke/snapshots.yaml`, and apply both, then `gke/client.yaml`.
3. Deploy the router as the comment in `gke/router.yaml` says.
4. Give the client a token for the `compare-client` service account
   (`kubectl -n compare create token compare-client --duration 48h`) and
   the cluster's CA.

The snapshot bucket needs hierarchical namespace, a managed folder for the
snapshots, and the IAM bindings the Pod Snapshot documentation lists for
the sandbox's Kubernetes service account and the GKE service agent.

Client settings: `COMPARE_GKE_SERVER`, `COMPARE_GKE_TOKEN_FILE`,
`COMPARE_GKE_CA_FILE`, `COMPARE_GKE_ROUTER` (the router's internal load
balancer, `http://IP:8080`), and optionally `COMPARE_GKE_NAMESPACE`,
`COMPARE_GKE_WARM_POOL`, `COMPARE_GKE_COLD_POOL`.

## E2B

`E2B_API_KEY` for E2B cloud. For our front door: `COMPARE_FRONT_DOOR_KEY`
and `COMPARE_FRONT_DOOR_DOMAIN` (or `COMPARE_FRONT_DOOR_API_URL` and
`COMPARE_FRONT_DOOR_SANDBOX_URL`), and `COMPARE_FRONT_DOOR_TEMPLATE`.

## Running

```sh
RESULTS=~/results bash run.sh ours-activate
RESULTS=~/results bash run.sh ours-create pool    # after host-agent.sh pool
RESULTS=~/results bash run.sh gke-latency
RESULTS=~/results bash run.sh ours-rate saved 300 5,10,20,50,100
bun bench.ts summarize ~/results/*.jsonl
```

Rate searches take `P99_LIMIT_MS` (default 1000) for states whose unloaded
p99 is already above half a second, and `STEP_SECONDS`, `WARMUP_SECONDS`,
`REFINEMENTS`, `REPEATS` (each rate offered that many times, each with its
own arrivals) and `SEED`. The reported runs used a fixed ladder around a
first search's limit with `REFINEMENTS=0` and `REPEATS=3` (2 for running
and paused). Ours opens one TCP connection per request through the
relay, so above a few hundred a second the client needs a wider port
range: `sysctl -w net.ipv4.ip_local_port_range="1024 65535"
net.ipv4.tcp_tw_reuse=1`.

`bench.ts cleanup --system NAME` lists what a system still has; remove
leftovers with that system's own tools. GKE claims carry the label
`compare.lab/run`, so `kubectl -n compare delete sandboxclaims -l compare.lab/run`
removes them.
