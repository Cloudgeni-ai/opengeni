# Combined server process experiment — NOT FOR MERGE

This is a disposable measurement harness, not a supported deployment mode. Do not
deploy it, enable it in Helm, or merge this branch. The only production-source
change is a small optional composition seam in `apps/worker/src/index.ts`;
ordinary worker defaults remain unchanged.

## Scope

`host.ts combined` hosts API, control worker, turn worker, artifact materializer,
artifact outbox dispatcher, and static web in one Bun process. It calls existing
factories rather than reproducing their business logic. `host.ts workers` joins
only the two workers. Neither mode changes task queues, concurrency, pool sizes,
database grants, scheduling ownership, native execution, or migration policy.

This is **not literally one OS process for the whole deployment**. PostgreSQL,
Temporal, NATS and object storage remain external services. Native artifact
materialization still launches a transient subprocess. The optional Connected
Machine relay is a Rust/Tokio executable and is disabled in this local scenario.
Embedding it would require a separately maintained native binding or rewrite;
it was not prototyped or measured. No remote-machine or sandbox tool was exercised.

## Measurements

Median of three runs (load RSS is the median of each run's sampled peak):

| Measure | Stock: six processes | Combined: one | Workers joined: five |
| --- | ---: | ---: | ---: |
| Application idle RSS | 1,820 MiB | 604 MiB | 1,510 MiB |
| Application load peak RSS | 2,853 MiB | 1,721 MiB | 2,585 MiB |
| Fresh-process readiness | 2.78 s | 5.19 s | 4.20 s |
| Four turns, discovery, tools and exports | 15.19 s | 18.31 s | 17.46 s |
| Worst sampled API health latency, range across runs | 8–17 ms | 1,175–1,390 ms | 9–66 ms |

Combined saves about **1,216 MiB / 67% idle application RSS** and **40% load peak
RSS**, but does not deliver faster startup in this prototype. Its startup is
partly serialized; that is not proof that all possible combined designs must be
slower. Infrastructure adds roughly 1.9–2.1 GiB summed RSS and is not eliminated.
Approximate whole-stack idle sums were 3,845 MiB stock versus 2,606 MiB combined;
these are not physical-memory accounting, for the reasons below.

**Recommendation: drop the all-in-one deployment mode for now.** The savings
are real, but a second lifecycle/fault/packaging contract is not maintenance-free,
and the experiment already exposed a fatal-policy conflict and API latency
regression. Joining only workers is the narrower candidate if about 310 MiB idle
RSS matters; it does not eliminate the need for cross-worker lifecycle tests.
Alternatively reduce heavy shared imports without removing isolation. Neither
alternative is proposed as a shipped feature by this branch.

See `measurements.json` for per-trial results and correctness receipts. The final
series alternates layout order across three repetitions on the same Linux x64
shared machine (32 visible CPUs), with Bun 1.4.0. No simultaneous builds were run.
This is a small-load experiment, not a capacity result for ten busy agents.

- **Stock** uses the real production API, control, turn, materializer and outbox
  bundles plus the stock static web entrypoint. **Combined** uses one experimental
  bundle. **Workers** uses that bundle for the two workers and stock other roles.
- A preliminary common-bundle split baseline overstated idle RSS by about 12%.
  It is not the baseline for the final memory comparison. Fault/CPU-contention
  tests intentionally use the common-bundle split layout, not stock.
- RSS is sampled every 250 ms from the role process trees, including transient
  native children. Idle is the median of the latter half of a 20-second window;
  load peak is the highest observed sample, not an allocator high-water mark.
  Shared memory pages can be counted repeatedly. This is **not PSS, cgroup memory,
  or a precise estimate of physical RAM reclaimed**.
- External infrastructure is measured separately. Its PostgreSQL connection
  processes repeat shared pages in RSS, so whole-stack sums are especially coarse.
  The same fixture is reused between layouts; persisted sessions/history accumulate.
- Startup means fresh application processes reaching all six readiness endpoints
  (web uses `/`), with infrastructure already ready and the OS file cache warm.
  It is not cold-machine startup, image pulling, native-runtime compilation,
  migration time, or initial Temporal setup.
- Four concurrent sessions use the real OpenAI Responses transport against a
  loopback deterministic fixture: discover an MCP tool, call it, then stream a
  short answer. Each tool creates a native spreadsheet, pins a version, exports
  XLSX, waits for completion and checks downloaded ZIP magic. These are tiny,
  empty spreadsheets, not large rendering workloads or all artifact modalities.
- The tool talks to real artifact APIs; this does not exercise the first-party
  agent artifact-tool authorization path. Final assertions require four durable
  `turn.completed` events, four successful exports and all corresponding outbox
  hints published. A bounded retry uses the **same** receipt key only for explicit
  idempotent database-contention responses.
- Fixture/model server and sampler memory are excluded equally. No external
  inference request is made. Native materialization uses the explicit local
  development unsandboxed gate, not a verified production sandbox policy.

The prototype is not an installable container. Combining roles does not remove
their dependency union or the native runtime. No release-image/install reduction
was demonstrated; adding together role image sizes would double-count shared
layers and would be misleading.

## Architecture and risks found

| Boundary | Existing ownership and implication |
| --- | --- |
| API | `apps/api/src/index.ts` owns HTTP, lifecycle pumps, DB/NATS/Temporal clients and native artifact engine. Default API pool is 32. |
| Workers | `apps/worker/src/index.ts` preserves independent control/turn clients and pools (ordinary pool 10 plus readiness pool 1 per role). Control owns internal schedules and three Temporal workers: base, sandbox lifecycle and browser checkpoint queues. Turns use the separate turns queue. |
| Process-global Temporal runtime | Logging/runtime initialization is a singleton, even with multiple service objects. Native SDK signals include SIGQUIT/SIGUSR2 as well as SIGINT/SIGTERM. The first fault probe accidentally stopped pollers with SIGUSR2; the corrected probe uses SIGUSR1. The host must treat unexpected normal role exit as host failure, not leave a healthy-looking API. |
| Materializer / outbox | Existing service factories and role-restricted database connections are retained (default materializer pool 3, outbox pool 4). Separate DB identities in one address space are not the same security boundary as separate processes. Native work remains out of process. |
| NATS and HTTP | No transport is replaced with in-memory calls. Each existing role keeps its readiness listener and messaging clients; public API/web are reused. There is no shipping unified readiness endpoint or aggregate metrics design. |
| Fatal errors | API fails fast on unknown unhandled rejections; the isolated worker deliberately survives detached SDK rejections. Both policies cannot remain isolated inside one process. The measured rejection probe killed the combined API but not the split worker/API. Weakening the API policy would be a behavior change, not a free fix. |
| Shutdown | Prototype closes API admission before worker/sidecar drain, preserves factory cleanup and exits if a role fails. Closing the full API also prevents an in-flight tool from calling it: correct production drain needs separate admission and internal-serving stages. Tests after tool completion do not establish safety halfway through arbitrary tool side effects. |
| CPU and crash isolation | Synchronous JS in any joined role can starve API handling. A native crash, OOM, cleanup hard-exit or process-wide fatal failure takes all joined roles down. Worker-only joining preserves API isolation but can still stall control work. |
| Migration / jobs | `scripts/dev-stack.sh` and the local launcher prepare dependencies/runtimes and migrate before app roles. `docker-compose.yml` supplies infrastructure, not one combined app daemon. Helm has separate deployments and a migration job. Migration owner credentials, catalog import and other lifecycle jobs must stay separate, not become normal API-host duties. |

### Fault and contention probes

The detached-rejection probe left the split API and worker running. The same
rejection killed the combined host with exit 1. After restart all four original
turns completed, with only four exports: about 170 seconds for the batch versus
30 seconds without the combined-host restart. A separate SIGTERM during streaming
(after durable tool outputs) exited cleanly and recovered all four turns without
repeating exports; that batch took 172 seconds. This does not prove arbitrary
mid-tool shutdown is safe.

A separate deliberately synthetic 500 ms synchronous JS block per model call
raised combined API health p95 to 347 ms, with one failed two-second-deadline
probe; split p95 was 38 ms with none. This is a fault demonstration, not a normal
model-provider workload or a memory-comparison baseline. Ordinary-load tail
latency in the table above is independently concerning.

## What supporting this mode would cost

The production seam adds 19 lines and removes 3 in one worker entrypoint; roughly
1,060 lines of experimental TypeScript implement the host/build/fixtures/benchmark
and summarizer (the host itself is 163 lines). No Helm or compose source is changed.
The source seam is small; the lifecycle contract is not. Shipping would need one
maintained service-composition API used by both modes, explicit ownership of
signals/fatal policy/readiness/drain/metrics, a supported package closure, and
installation/Helm/local-launch wiring. A copied second startup implementation
would silently drift as roles gain startup validation, clients or background jobs.

At minimum CI would run **both layouts** against real PostgreSQL, Temporal, NATS
and object storage, asserting turns with tool discovery, artifact export and
outbox delivery; failed startup and unexpected poller exit; SIGTERM during tool
work and SIGKILL/restart without duplicate side effects; DB/NATS reconnect;
event-loop latency; and final packaged native-runtime startup on supported CPU
architectures. Existing isolated-service unit tests alone cannot detect the
process-global conflicts found here. This branch deliberately adds no deployment
mode or CI commitment. Treat a several-hour agent implementation as plausible,
not the hard part: the lasting obligation is maintaining that integration matrix
and reviewing every role-lifecycle change against it.

## Reproducing locally

Use a disposable worktree with an owner/purpose/expiry record. Do not source a
deployment environment. Install with `bun install --frozen-lockfile`; prepare the
source-matched native development artifact runtime using the repository's normal
development runtime preparation, which must create
`.opengeni/artifact-runtime-development/installation.development.json`.

```sh
bun --no-env-file scripts/prepare-development-artifact-runtime.ts \
  --repository-root "$PWD" --output "$PWD/.opengeni/artifact-runtime-development"
bun --no-env-file scripts/experiments/combined-server/setup.ts
bun scripts/build-runtime-processes.ts
bun --no-env-file scripts/experiments/combined-server/build-web.ts
bun --no-env-file scripts/experiments/combined-server/build.ts
EXPERIMENT_HTTP_MODEL=true EXPERIMENT_BUNDLED=true EXPERIMENT_REPEATS=3 \
  EXPERIMENT_LAYOUTS=stock,combined,workers EXPERIMENT_RESULT_NAME=final \
  bun --no-env-file scripts/experiments/combined-server/run.ts
EXPERIMENT_HTTP_MODEL=false EXPERIMENT_BUNDLED=true EXPERIMENT_REPEATS=1 \
  EXPERIMENT_LAYOUTS=split,combined EXPERIMENT_FAULT=rejection \
  EXPERIMENT_RESULT_NAME=rejection \
  bun --no-env-file scripts/experiments/combined-server/run.ts
bun --no-env-file scripts/experiments/combined-server/summarize.ts final rejection
bun --no-env-file scripts/experiments/combined-server/cleanup.ts
```

The benchmark-only web builder excludes the existing eager-graph size guard,
which failed on the unmodified web build. It reuses actual assets but is **not a
release-build validation**. `build.ts` creates local dependency symlinks, not a
portable release. Do not run setup twice without cleanup: `.state/stack.json` is
the ownership receipt for the disposable stack. Normal `run.ts` completion cleans
its child processes; after a forcibly interrupted runner, inspect its recorded
`.state/active.json` and verify ownership before stopping leftovers. Cleanup only
removes the exact recorded stack and its image-pin fixtures, never host-wide Docker
state. Raw fixture state/logs must not be committed.

## Verification boundary

Existing embedded-worker lifecycle, Temporal runtime logger, materializer-service
and outbox-service tests passed: 40 tests, 147 assertions. The repository's full
41-project typecheck passed; the experiment also has a separate `tsconfig.json`.
The standard web build failed its existing eager-graph budget (274,745 bytes
versus 32,768 allowed), hence the explicitly marked benchmark-only bypass above.
No production image, ARM build, relay, actual external provider, DB/NATS outage,
large document render or long-running soak test was validated. Normal shutdown
receipts include stock web's expected signal exit 143 rather than exit 0.
