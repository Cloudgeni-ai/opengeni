# Turn startup latency investigation

Status: completed implementation experiment; retained as a measurement record.

Baseline audit: `origin/main` was
`478d7fe8feed740ae155fdc5cf7f253f2606bbb4` (2026-08-13). None of the
startup-phase metrics, the local lazy-provision defaults, or the stale-Docker
error repair in this experiment were present in that baseline. The sandbox
Dockerfile had both broad `COPY . .` build stages.

## Goal

Reduce non-model time from an observed roughly 85-second blank startup (about
74 seconds in the attributable pre-model path) to below 1.5 seconds
without weakening tenant isolation, same-session ordering, durable events,
credential fairness, file integrity, or exact per-attempt tool authority. Measure
model time separately.

## Confidence legend

- **Confirmed**: visible in current code or reproduced locally.
- **Strong hypothesis**: supported by incident timings and code shape, but missing a
  phase span.
- **Unproven**: plausible and worth an experiment; do not optimize yet.

## Complete suspect register

| Area | Confidence | Current finding | Experiment / likely improvement |
| --- | --- | --- | --- |
| Queue/admission | Strong hypothesis | A roughly 64-minute delay looks like same-session FIFO, not global capacity. | Record queue reason and eligible/admitted timestamps. Keep same-session serialization; make the reason visible. |
| Credential selection | Confirmed, currently small | Clean one-account Luna runs selected the account in roughly 68–88 ms; request-time token resolution was 6–13 ms. The broad UI label had overstated this area. | Still split policy lock, fairness, lease, session write, and event append before multi-account/rotation tests. Optimize only if those matrices expose growth. |
| Event persistence | Strong hypothesis | Incident evidence showed durable append around seconds while NATS publish was tens of milliseconds. | Split DB append/commit/lock-wait from publish. Optimize the DB path but keep durable-before-publish. |
| Connected-machine files | Confirmed | Current self-hosted path processes files serially. Every file emits start/end events and executes a separate size/SHA check; download happens only on mismatch. Durable cache is intentionally disabled because the user may mutate files. | Test 0/1/5/20 files, present/missing/mutated, and multiple sizes. Prototype one manifest-based batch verification or bounded parallel checks while preserving atomic replacement, hashes, read-only mode, and truthful per-file results. |
| MCP/tool preparation | Confirmed bottleneck; nonblocking fresh-turn path implemented on branch | Normal tools cost 927 ms average before the experiment; 630 ms was catalog build, dominated by recompiling JSON-schema validators. A bounded content-addressed validator cache reduced warm tool prep to 243–314 ms. Fresh progressive turns now wait only for per-session `eager: true` MCPs; strict and optional non-eager servers prepare concurrently, and plain output does not join them. Worker first-party calls use the internal route rather than a public tunnel. | Measure live local/Modal first-token improvement and tool-search join latency. Preserve full preparation for approval resumes and editable-artifact catalog identity. |
| Agents SDK tool projection | Confirmed | The SDK converts and serializes the full authorized MCP surface before every request. Six Luna samples measured 1.53 seconds average for normal tools versus 1.12 seconds for the minimal surface, with a material cold/JIT effect. Codex `defer_loading` saves provider context but still sends and locally serializes every deferred schema. | Measure the SDK `getAllTools` projection separately. Investigate a safe attempt-local prepared projection or a smaller eager first-party surface; do not cache permission-scoped tools across sessions. |
| Conversation history | Confirmed shape, latency unproven | The active history is loaded and the full array is projected, attachment-materialized, sanitized, and prepared before inference. A prior case had 267 items, about 922 KB, and 216k input tokens without pre-turn compaction. | Benchmark 0/10/100/250 items and 1k/32k/200k tokens. Add phase spans and consider earlier compaction or incremental prepared-history state. |
| Post-file gap | Strong hypothesis | Roughly 18 seconds was unattributed between file completion and provider dispatch. | Attribute it across history DB read, attachment projection, agent build, tool catalog persistence, and stream/provider setup. |
| NATS credentials | Confirmed correction | Enrollment bearer and relay token are 30 days on current main. Auth-callout user JWT is capped at 5 minutes and reminted on reconnect. The earlier “5-minute enrollment credential” description was wrong. | Test before/near/after the 5-minute user-JWT expiry and transport interruption. Ensure reconnect/refresh is proactive or outside the turn critical path. |
| Worker load balance | Unproven | One production worker previously carried materially more inflight work and memory, but the host was not exhausted. | Measure single-worker first, then controlled two-worker distribution. Do not infer causality from one snapshot. |
| UI visibility | Confirmed | “Waiting for first step” hides queue reason and pre-model phase progress. | Surface queued/admitted/startup phase and elapsed time from durable low-cardinality milestones. |
| Local port discovery | Confirmed and reproduced | macOS `lsof` blocked about 20 seconds per probe on an unhealthy OrbStack NFS mount. | Prefer bounded loopback `nc`; retain fallbacks. |
| Host filesystem health | Confirmed symptom, broader cause unproven | The full repository gate later reported OrbStack NFS `resource temporarily unavailable` while the unchanged Channel-A real-local-box suite accumulated four 26–42 second filesystem/Git failures in a narrow rerun. The worktree itself is on APFS, so the exact cross-mount causal chain is not yet proven. | Keep this separate from turn latency. Add host/mount health to local diagnostics; do not weaken Channel-A confinement or inflate its timeouts to conceal an unhealthy machine. |
| Remote local-development endpoints | Confirmed and reproduced | Default local enrollment advertises loopback endpoints and binds the relay to loopback, so a remote Connected Machine cannot reach it. | Allow an explicit local relay bind, validate and briefly claim its exact address before startup, and advertise the Mac's Tailscale API/NATS/relay endpoints. |
| Cold sandbox image build | Confirmed, separate | The first local stack boot builds a large sandbox image and tool runtimes. | Treat as environment setup, cache it, and exclude it from per-turn latency. |
| Local image rebuild invalidation | Confirmed and reproduced | An ordinary worker/runtime edit invalidates two broad `COPY . .` stages. The latest restart spent about 63 seconds in Docker and about 94 seconds before the full stack was ready; dependency install, artifact-runtime preparation, and multi-gigabyte source copies reran. | Replace broad source dependencies with an exact image-input closure or a content-addressed local image admission receipt. Never skip a build on `HEAD` alone because dirty relevant source must invalidate it. |
| Exact-head artifact runtime | Confirmed, separate | No successful hosted artifact existed for this main SHA, so local standalone Office artifact operations are disabled. | Record as environment parity; it is not evidence of a turn-start bottleneck. |
| Provider timing semantics | Confirmed | The existing request `headers` duration begins before the durable `agent.model.request started` append, so it includes audit persistence and is not a pure provider-network measurement. | Keep the durable-before-fetch fence, but report request preparation, start audit, and post-audit provider wait separately. |
| Lazy sandbox policy | Confirmed defect and fixed locally | Current main leaves lazy provisioning off by default. The first attempted dev fix also used the plausible but wrong `_ENABLED` suffix; config actually reads `OPENGENI_SANDBOX_LAZY_PROVISION`. The new bounded policy-reason metric exposed this immediately as `eager/lazy_disabled`. | Local dev now exports and persists the exact config key plus ownership. Keep the reason metric. Production enablement needs its own staged rollout because credentials, generated-video inputs, and signed file resources intentionally remain eager. |
| Stale local Docker identity | Confirmed defect and fixed locally | A resumed session can retain a deleted container id. Docker emits `Error response from daemon: No such container`, but current main only recognizes `Error: No such container`, so the typed recovery path is skipped and the raw error reaches the user. | Accept only the exact container id with either known Docker prefix, then reuse the existing typed unavailable-instance recovery. |

## Measured local results

All synthetic calls use `codex/gpt-5.6-luna`, low reasoning, a managed Docker
sandbox, no file resources, and the same `Reply with exactly ready.` prompt.
Model/provider time is excluded from the pre-network comparisons.

### Six interleaved samples per tool condition before the cache experiment

| Phase | Minimal tools | Normal 80-tool UI surface | Normal penalty |
| --- | ---: | ---: | ---: |
| Required MCP connect | 119 ms | 133 ms | 14 ms |
| Optional MCP connect | <1 ms | 70 ms | 70 ms |
| Attempt catalog build | 66 ms | 630 ms | 564 ms |
| Attempt catalog persist | 10 ms | 79 ms | 69 ms |
| Total tool preparation | 195 ms | 927 ms | 731 ms |
| SDK projection/serialization | 1,119 ms | 1,528 ms | 409 ms |
| Credential resolution at request time | 13 ms | 6 ms | none |
| Wire normalization | <1 ms | <1 ms | none |
| Durable model-request start audit | 44 ms | 31 ms | none |

Queue-to-worker handoff was 0.22–0.46 seconds. Warm minimal sessions reached the
request boundary in 0.94–1.68 seconds; normal sessions were usually 1.33–2.47
seconds, with one 5.97-second outlier. That outlier remains a required
per-sample investigation, not noise to discard.

### Bounded validator-cache experiment

`createAttemptToolEnvironment` was recompiling all JSON-schema validators with
AJV for every attempt. The experiment reuses only exact content-addressed
validator functions in a 512-entry process-local LRU. Attempt scope, digest,
executor closures, catalog persistence, and authorization remain newly created
for every attempt.

| Normal-tool run | Catalog build | Total tool preparation | Turn start → request |
| --- | ---: | ---: | ---: |
| First cold run | 576 ms | 981 ms | 2.19 s |
| Warm range (five runs) | 88–123 ms | 243–314 ms | 0.86–1.31 s |

The warm normal path, including queue handoff, is now roughly 1.1–1.6 seconds.
This meets the 50× target relative to the 85-second incident for this clean
Docker/no-file/small-history baseline. It does **not** yet prove the original
large-history, multi-file, same-session, or Connected Machine cases.

### Lazy-provision correction and repeated Luna proof

Every model call in this investigation is pinned to `codex/gpt-5.6-luna`.
Non-model probes use no model at all. A bounded policy-decision metric records
`eager`/`on-demand` and one closed reason without session, credential, file, or
sandbox identifiers.

Before correcting the local config key, zero-file/no-first-party-tool Luna turns
reported `eager/lazy_disabled` and paid:

- sandbox establish: 0.73–1.49 seconds;
- owned sandbox setup: 0.56–0.90 seconds;
- one Docker sandbox created before the model request.

After exporting the exact `OPENGENI_SANDBOX_LAZY_PROVISION=true` key:

- nine consecutive Luna turns all reported `on-demand/eligible`;
- average worker preparation before entering the runtime was 0.368 seconds
  (`3.313 / 9`); lazy SDK request preparation and the durable request-start
  audit were measured separately and are not included in that number;
- average sandbox-establish bookkeeping was 0.020 milliseconds
  (`0.000176 / 9`);
- zero Docker sandboxes were created by those chat-only turns;
- active history grew through the `21+` count bucket without leaving the target.

The first subsequent `exec_command` created exactly one Docker sandbox in
0.537 seconds. A second turn read and appended the marker from the same exact
instance
`fba61104cc50168d379f5c7e8ae4be5dc3720b7b4524a7e07fec71fd1010d3f8`.
This proves both halves of the contract: chat-only turns do not provision, and
the first real sandbox operation provisions single-flight without losing
same-session workspace continuity.

### Verification state

After the experiment branch was rebased onto the then-current `origin/main`, the
focused changed-path suites reported 716 passes and 0 failures. Worker, runtime,
Codex, and Codemode typechecks passed; the development-stack shell syntax,
formatting, and diff checks also passed.

The pre-rebase full `bun prep` reached 9,152 passes and 5 failures across 1,006
test files. The observed failures were confined to the unchanged Channel-A
real-local-box suite during the host filesystem incident above. A narrow rerun
of that unchanged file reported 70 passes, 2 skips, and 4 failures, all in slow
filesystem/Git cases. This is not called green, and it is not attributed to this
branch without evidence. Hosted CI remains the clean-environment arbiter.

## Simple decision register

| Keep / fix | Item | Why |
| --- | --- | --- |
| Fix | Recompile identical tool validators every turn | Pure repeated CPU; bounded content-addressed reuse preserves authority. |
| Fix | Keep local lazy provisioning disabled accidentally | Pure pre-model waste for chat-only turns. Use the exact config key, retain eager exceptions for credentials/video/signed files, and expose the bounded reason. |
| Fix | Let a deleted Docker id escape as a raw inspect error | It prevents the existing typed recovery path; the matcher can remain exact and fail closed. |
| Fix separately | Rebuild the full sandbox image after unrelated worker edits | It adds about a minute to every instrumentation restart and discourages rigorous testing. Use an exact content closure, not a stale image shortcut. |
| Investigate then likely fix | Re-project and serialize the full tool surface for every request | Still 0.45–0.80 seconds warm and larger for cold/outlier runs. Any cache must remain attempt-safe. |
| Fix visibility | Blank UI during queue and startup | The user cannot distinguish queueing, local setup, and model time. |
| Fix if scaling test confirms | Serial Connected Machine file verification | Correct today but likely linear in file count and remote command latency. |
| Fix if incident reproduces | Slow durable event appends | Clean local audit append is tens of milliseconds; incident evidence was seconds. Durable-before-publish stays. |
| Keep | Credential resolution itself | Measured 6–13 ms at request time; not a bottleneck. |
| Keep | Request wire normalization | Measured below 1 ms. |
| Keep | Required MCP fail-closed behavior | Security/correctness invariant; optimize implementation, not semantics. |
| Keep | Exact attempt catalog and durable start audit | Required fencing and forensic truth. Optimize their mechanics, never remove them. |
| Keep | Eager provisioning for resolved run credentials, generated-video inputs, and signed file resources | Those bytes must be materialized into one exact leased box before the first model boundary so failures are represented in model input. The new reason metric makes this cost explicit. |
| Keep | 5-minute NATS auth-callout JWT | It is a scoped transport credential, not the 30-day enrollment identity. Test reconnect behavior; do not lengthen it merely to hide churn. |
| Separate | Provider/model response time | Variable and externally controlled; never charge it to local startup work. |

## Required instrumentation

One worker-preparation total plus a phase family with low-cardinality labels:

1. queue/admission and reason
2. turn claim
3. credential policy lock, selection, lease, session write, event append, token resolution
4. sandbox establish
5. file resolve, verify, download
6. MCP connect, list, catalog freeze, catalog persist
7. history read, deserialize, sanitize/project, attachment materialize
8. agent construction
9. provider dispatch

The worker-preparation total intentionally ends when control enters the runtime.
Lazy SDK request preparation, the durable model-request audit, and provider wait
remain separate phase observations; calling the worker-only slice an end-to-end
pre-model total would understate real non-model latency.

Implemented phase splits now cover tool server construction, required/optional
connect, catalog build/persist, detailed history preparation, SDK sandbox/client
preparation, request-time credential resolution, wire normalization, durable
request-start audit, provider lifecycle, event append, NATS publication, and the
bounded sandbox establish-policy reason. Queue-reason, per-file Connected Machine
work, and credential-selection internals remain.

Labels: provider, sandbox backend, phase, outcome, count bucket, cache hit/miss.
Attempt/session identifiers belong only in logs and traces.

## Baseline matrix

Use the same prompt, history, attached files, MCP set, and tool policy:

1. One Codex subscription account, rotation off, Docker sandbox.
2. The same Codex account on one Connected Machine.

Grok/SuperGrok is explicitly out of scope. Only after the two Codex baselines:
multiple credentials/rotation, many files, many MCP
servers, long history, NATS expiry boundaries, and concurrent workers.

## Safety invariants to keep

- Same-session turns remain ordered.
- Required MCP servers fail closed.
- Startup diagnostics fail open: an observer or legacy manifest inventory failure
  is recorded as failed but can never block provider dispatch.
- Soft file-download failures keep their model-facing failure note and are also
  reported as failed startup materialization, never as a successful phase.
- The exact attempt tool catalog remains frozen and durable.
- Events remain durable before live publication.
- File writes remain hash-verified, atomic, and read-only.
- Connected Machines retain ambient user filesystem and credential authority;
OpenGeni does not clone a replacement repository or inject platform GitHub
credentials.
