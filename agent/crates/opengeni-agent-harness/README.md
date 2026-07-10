# opengeni-agent-harness

A dev-only, deterministic **load + chaos harness** for the `opengeni-agent`
control-plane surface. It drives the **real** agent binary against a **real**
local `nats-server`, speaking the exact prost `ControlRequest`/`ControlResponse`
request/reply the control plane speaks (`agent.<ws>.<id>.rpc`), and emits
machine-readable JSON plus a human summary.

It is the instrument every subsequent reliability change is measured against:
baseline → change one lever → re-measure against the same scenarios.

> **Never released.** `publish = false`, binary name `og-agent-harness`. It is a
> measurement tool, not a product surface.

## Safety: it never touches your real enrollment

Every agent the harness runs is **disposable**: it gets its own temp
`$OPENGENI_CONFIG_DIR` containing a hand-written `credentials.json` (a throwaway
bearer a no-auth local server accepts), dials a throwaway local `nats-server` on
a random port, and is killed on exit. The harness spawns each child in its own
process group and installs a panic hook + signal handler + per-handle `Drop`
guards so a crash or Ctrl-C never leaks an agent, a server, or an exec child.

## Requirements

- The workspace built: `cargo build -p opengeni-agent` (the harness defaults to a
  sibling `opengeni-agent` next to its own binary).
- A `nats-server` binary. Resolution order: `--nats-server <path>` /
  `$HX_NATS_SERVER` → `$PATH` → a `/nix/store` scan. If none is found, install one
  or run `docker run --rm -p 4222:4222 nats:2-alpine` and pass its path.

## Running

```sh
cargo build -p opengeni-agent            # the binary under test
cargo build -p opengeni-agent-harness    # the harness

# Prove the disposable-agent path works before anything else:
./target/debug/og-agent-harness milestone0

# Individual scenarios:
./target/debug/og-agent-harness baseline
./target/debug/og-agent-harness flood
./target/debug/og-agent-harness large
./target/debug/og-agent-harness long
./target/debug/og-agent-harness chaos-nats
./target/debug/og-agent-harness chaos-agent
./target/debug/og-agent-harness soak        # 10 minutes; excluded from `all`

# Scenarios 1-6 in sequence (fresh fleet each):
./target/debug/og-agent-harness all

# Record current behavior without failing on a broken invariant (baselining):
./target/debug/og-agent-harness all --no-assert
```

Useful flags (all global): `--seed <n>` (op-mix determinism, default 42),
`--fleet-size <n>` (flood part b, default 32), `--pause-secs <n>` (chaos-nats
freeze, default 30), `--soak-secs <n>` (default 600), `--agent-log <filter>`
(the disposable agents' `RUST_LOG`), `--results-dir <dir>`, `--agent-bin <path>`,
`--nats-server <path>`.

Each scenario writes `results/<scenario>-<ts>.json` (under `--results-dir`,
default `<exe_dir>/harness-results`, git-ignored) and prints a summary. **Exit
code is 0 iff every verdict passed** (unless `--no-assert`).

## What each scenario proves

| scenario | what it exercises | key invariants |
|----------|-------------------|----------------|
| `milestone0` | one disposable agent online | heartbeats within 15s + a ping round-trip |
| `baseline` | 1,000 pings, 200 small execs, 100 fs ops | reference latencies; zero errors; ping p99 < 100ms |
| `flood` | 256 concurrent ops on 1 agent + 32×16 fleet | **control-liveness isolation** (ping p99 < 100ms while host work saturates); 8-slot saturation returns `DRAINING`; no heartbeat gap > 7.5s |
| `large` | exec/fs_read/fs_write at 256KB–8MB | the ~1MB payload wall is **typed** (`PAYLOAD_TOO_LARGE` reply-side, `REQUEST_TOO_LARGE` request-side), never a silent timeout |
| `long` | `sleep 45` @ 30s deadline, `sleep 5` @ 30s | the 30s exec wall is a **typed** `timed_out`; a shorter exec succeeds; heartbeats keep 5s cadence throughout |
| `chaos-nats` | server restart + SIGSTOP freeze under an in-flight exec | reconnect convergence < 15s; the in-flight op is killed by the reconnect; heartbeats resume after a freeze |
| `chaos-agent` | agent SIGKILL + clean SIGTERM under an in-flight exec | a hard crash leaves no orphaned compute; restart heartbeats < 15s; clean stop reaps the child (and *should* emit GoingOffline) |
| `soak` | 10 min moderate seeded load | RSS drift < 20%, fd count flat (±4) |

## Output contract

```json
{
  "scenario": "flood",
  "seed": 42,
  "config": { "single_agent_ops": 256, "fleet_size": 32, "max_in_flight_control_rpcs": 8 },
  "started_at_unix_ms": 1783680704000,
  "agent_version": "opengeni-agent 0.1.7",
  "measurements": {
    "latency_us": { "ping": { "p50": 331, "p90": 600, "p95": 629, "p99": 763, "max": 1310, "count": 1000 } },
    "errors": { "DRAINING": 177 },
    "heartbeat_gaps_ms": { "hx-agent-0": [5000, 5001] },
    "resources": [ { "t_ms": 0, "rss_bytes": 17825792, "fds": 11, "threads": 22 } ]
  },
  "verdicts": [ { "check": "…", "pass": true, "detail": "…" } ]
}
```

## Sample output

```
=== scenario: baseline (seed 42) ===
agent_version: opengeni-agent 0.1.7

latency (microseconds):
  op              count        p50        p95        p99        max
  exec_echo         200       4815       5971       6859       7187
  fs_list            50        912       1068       1858       1858
  fs_stat            50        903       1192       1255       1255
  ping             1000        331        629        763       1310

verdicts:
  [PASS] baseline ran clean (no errors) — 0 typed errors across 1300 ops
  [PASS] ping p99 < 100ms on an idle agent — p99=763us

overall: PASS
```

## First baseline (agent 0.1.7, local nats-server 2.10.x, 8 slots, 1 MiB max_payload)

- **baseline** — ping p50 331µs / p99 763µs; small exec p50 4.8ms; fs stat/list ~0.9ms; RSS flat ~17 MiB, fds 11–15; 0 errors across 1,300 ops.
- **flood** — under 256 concurrent ops on one agent, a concurrent ping probe holds p99 ≈ 7.6–9.6ms (< 100ms): control liveness is isolated from host-work saturation. ~172–177 of the 256 ops are shed as `DRAINING` (8 slots, no queue). All 32 fleet agents keep heartbeating with zero > 7.5s gaps.
- **large** — the wall is exactly `max_payload` (1,048,576 bytes): 256KB/512KB/900KB exec-stdout, fs_read, and fs_write all succeed; 2MB and 8MB fail. Every oversized op is **typed** (reply-side `PAYLOAD_TOO_LARGE`, request-side `REQUEST_TOO_LARGE`); none times out silently.
- **long** — `sleep 45` @ 30s deadline returns a typed `timed_out` at ~30.0s; `sleep 5` succeeds at ~5.0s; heartbeats stay on their 5s cadence during the long exec.
- **chaos-nats** — a server restart mid-exec reconverges heartbeats in < 4s and **kills** the in-flight exec (a reconnect aborts the generation — "blip = kill"). A 30s SIGSTOP freeze does not drop the connection; heartbeats buffer and flush on SIGCONT.
- **chaos-agent** — a hard `SIGKILL` of the agent leaves **no orphaned compute**: the agent isolates each exec into an anchored process group whose anchor is *stopped*, so when the agent dies the orphaned group receives `SIGHUP` and the exec is reaped (verified with a standalone fork experiment). The agent restarts and heartbeats in ~0.2s.

### Finding surfaced by the harness

`chaos-agent` reproducibly shows that **a clean `SIGTERM` during an active
connection does not emit a `GoingOffline` event**. The supervise loop's *biased*
outer `shutdown.notified()` branch returns before `serve_connection_generation`
can announce, so the lease waits on heartbeat dead-detection instead of flipping
offline immediately. The in-flight exec child is still reaped (the generation's
`JoinSet` drop terminates it), but the fast-offline signal is lost. This is the
kind of latent behavior the harness exists to catch.

## Design notes

- **Deterministic.** A seeded `StdRng` fixes every op-mix order; fixed op counts;
  assertions measure rather than sleep-and-hope. The `seed` + `config` are written
  into each result so a run reproduces.
- **Boring on purpose.** The harness's own code is small and shared — one runner,
  one driver, scenarios are `(config + op mix + verdicts)`. Its job is to be
  trusted.
- **Out of scope (for now):** relay/pty/desktop streams, auth-callout (the local
  server is no-auth), self-update, network fault injection (toxiproxy), CI wiring.
```
