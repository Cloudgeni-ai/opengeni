# Compute smoke suite

End-to-end scenarios that drive a real host agent, real Firecracker VMs and a
real guest, the way a product would: create a sandbox, run commands, move
files, let it sleep at every level, wake it by using it, restart the agent,
and check that nothing was lost.

The framework and the E2B-style (`ecw.*`) scenarios come from
[SPACE](https://github.com/perplexityai/SPACE)'s `space_smoke`, under the
Apache License 2.0; see [`../NOTICE`](../NOTICE). The `compute.*` scenarios
are ours and cover what this fabric promises beyond SPACE: several sleep
levels, concurrent wakes, holds, and surviving host-agent restarts.

## Running it

Python 3.10 or later, standard library only.

1. Put the reference guest service into a copy of a root disk image that has
   systemd and Python:

   ```sh
   cp --sparse=always base.ext4 smoke.ext4
   sudo guest/install.sh smoke.ext4        # vsock ports 55 and 56 by default
   ```

   The defaults stay clear of the ports the lab image's own guest services
   use (52 to 54, see `../lab/host-setup.sh`), so `base.ext4` can be the lab
   image.

2. Start a host agent that creates sandboxes from that image. A `--store`
   enables the archived and remote levels, and `--restore-notice-port` must
   match the guest's restore listener (56 by default) so restored guests are
   told, as the concurrent-wake scenario checks:

   ```sh
   sudo compute-host --socket /run/compute-smoke.sock serve \
     --root /var/lib/compute-smoke --firecracker /usr/local/bin/firecracker \
     --kernel vmlinux --base-image smoke.ext4 --store /var/lib/compute-smoke-store \
     --restore-notice-port 56
   ```

3. Run the suite from this directory:

   ```sh
   export COMPUTE_SMOKE_SOCKET=/run/compute-smoke.sock
   python3 -m compute_smoke list
   python3 -m compute_smoke run --all
   python3 -m compute_smoke run ecw.pause_connect
   python3 -m compute_smoke run --category compute
   python3 -m compute_smoke run --all --shard 1/4
   ```

   Each scenario prints its phases, a `PASS`, `FAIL` or `ERROR` line and a
   `RESULT` line of JSON evidence. The exit status is non-zero when any
   scenario did not pass.

Settings, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `COMPUTE_SMOKE_SOCKET` | `/run/compute-host.sock` | The host agent's socket |
| `COMPUTE_SMOKE_GUEST_PORT` | `55` | The guest service's vsock port |
| `COMPUTE_SMOKE_RESTART_AGENT` | unset | A shell command that restarts the host agent, keeping its state; the restart scenario needs it |
| `COMPUTE_SMOKE_SCENARIO_PACKAGES` | `compute_smoke.scenarios` | Comma-separated packages to load scenarios from |

The suite's own tests need no VM:

```sh
python3 -m unittest discover -s compute_smoke/tests -t .
```

## How SPACE's API maps onto ours

SPACE's scenarios talk to an E2B-compatible control and data plane. Here a
thin adapter (`compute_smoke/client.py`) gives them the same `Sandbox`
handle over two local protocols: the host agent's JSON socket, and a small
guest service (`guest/smoke_guest.py`) reached through the agent's `connect`
stream on a vsock port. The scenario bodies stay as they were.

| SPACE / E2B | Here |
|---|---|
| Create a sandbox from a template | `create`; the first use boots it from the base image |
| `commands.run`, background processes, reattach | Guest service `exec`, `spawn`, `processes`, `wait`, `signal` |
| Files API, directory watcher | Guest service `read`, `write`, `mkdir`, `list`, `rename`, `remove`, `exists` and `watch` |
| Sandbox timeout | Idle time before the sandbox pauses on its own |
| `set_timeout`, refresh | A named hold with an expiry; a hold keeps the sandbox awake |
| Pause, suspend | A sleep request to `paused` or `saved` |
| Connect to a paused sandbox | Any access wakes it |
| Delete | `remove` |

## What changed from SPACE

- Telemetry, Kubernetes discovery and SPACE's control-plane identity checks
  are gone; the runtime only needs the agent's socket.
- A sandbox here wakes on any access, as an Opengeni sandbox does. Two
  scenarios that proved a sleeping sandbox refuses access instead prove it
  stays asleep, with its state saved to disk, until used:
  `ecw.access_idle_reconnect_preserves_workspace` and the second half of
  `ecw.timeout_update`. Each says so at its top.
- Durable suspension waits for the agent to report the sandbox saved to
  disk, rather than for a SPACE control-plane phase.

## Scenarios not brought over

| SPACE scenario or group | Why |
|---|---|
| `pause_timeout_requires_connect` | Sandboxes here wake on access, so there is nothing to require |
| List pagination | A control-plane job; the host agent lists one host |
| Identity and ownership | The guest agent's job, not the fabric's |
| Public ports and loopback | No previews yet |
| Egress policy | Comes with egress policy |
| `immediate_egress`, `internet_access_allowed`, `guest_vlan_frames_dropped` | Pending the per-sandbox network and firewall work |
| `cold_create_environment`, `warm_pool_environment` | Pending the warm pool |

`compute.agent_restart_keeps_sandboxes` is quarantined until the host agent
keeps VMs running across its own restarts; run it by name to check that
work.
