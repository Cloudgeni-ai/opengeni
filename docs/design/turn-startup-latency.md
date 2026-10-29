# Turn startup latency: unchanged model requests

Measured 2026-10-29 against baseline `ffca00e50186`. This change removes redundant
work, not prompt content. It does **not** establish that a remote deployment's
roughly 2.4-second startup has reached 0.6 seconds.

## Path from HTTP acceptance to model dispatch

1. HTTP session/message routes authorize the caller, resolve the accepted model,
   resource and connection policy, and call core admission. Initial session
   creation reserves its shell before `initializeSessionStartAtomically`;
   subsequent messages use `postUserMessageTurn` and
   `submitHumanPromptInTransaction`. The accepted input, turn, snapshots and
   workflow-wake revision commit atomically. No work starts from an uncommitted
   prompt. Local HTTP-to-queued median/p90 was **43/75 ms** before and **49/73 ms**
   after; this stage was not changed.
2. Post-commit live fanout and `wakeSessionWorkflow` already overlap. The API
   client's `signalWithStart` wakes the control workflow immediately; the durable
   wake outbox is recovery, not a foreground polling delay. Acknowledgement still
   follows signal acceptance.
3. `sessionWorkflow` observes with `peekSessionWork`, then schedules the
   non-retryable `runAgentTurn` on its separate turn queue. Observation is not
   claim authority. Dispatch plus pre-claim setup was approximately **61 ms
   median** in both local variants (per-sample queue-to-start residual after
   subtracting the claim and start-settlement spans). This is a combined residual,
   not separately measured API, Temporal matching and activity transit times.
4. `claim.ts` resolves the catalog, performs the atomic claim, reloads the
   session/capability/provider settings, freezes/checks accepted policy and checks
   allowance before settling `turn.started`. Before-change nested medians were
   **0.8 ms** catalog read, **38.2 ms** atomic claim, **11.4 ms** session reload,
   **3.3 ms** capability settings and **3.6 ms** provider settings. Some overlap;
   the enclosing claim-and-policy median was **63.3 ms**, not their sum.
   Start settlement was **16.0 ms**. Services initialization was below **0.1 ms**
   on warm workers.
5. `run.ts` joins learning-policy freeze and attachment authority, prepares
   governance/model policy, compaction and tool policy, resolves sandbox routing
   and repository bindings, binds/resolves credentials, mints run credentials,
   and establishes the selected sandbox. The fixture uses `sandboxBackend=none`:
   no physical provisioning, external credentials or connector network I/O is
   represented. Runtime preparation was **28.6 ms**, including the **2.0 ms**
   session-MCP-settings read. Learning freeze and attachment authority were
   **2.3/1.3 ms** in parallel.
6. The credential-mint-to-tools gap includes receipt persistence, sandbox/file
   bookkeeping and `prepareTurnToolRuntime`'s GitHub/local-server construction,
   live linked-identity check, workspace/Skill metadata, title plan and native
   definitions. `tools` then resolves initiating-human context, constructs the
   exact tool environment and persists its catalog before publishing completion.
7. The tools-to-model-preparation gap includes the completion receipt,
   recovery-aware instructions, ordered Skill/governance history receipts,
   fresh linked authority, reasoning/router history, agent construction and
   history preparation. Post-tool work was **15.3 ms**, agent construction
   **1.3 ms**, and history preparation **6.2 ms**. These durable boundaries remain
   serial; parallel history writes would risk changing model-visible order.
8. Model preparation projects input and joins prerequisites. The literal
   pre-wire boundary still checks admission, checkpoints history and commits its
   request audit. `agent.model.request:started` precedes that commit; actual
   transport dispatch is later. Model preparation and request-audit spans can
   overlap milestone intervals and must not be summed as independent work.

## Changes and individually observed savings

| Step | Before median/p90 ms | After median/p90 ms | What changed |
| --- | ---: | ---: | --- |
| Tool-context preparation | 31.7 / 41.8 | 28.8 / 33.4 | Workspace settings and independent video/Skill metadata reads share one `allSettled` join, after the linked-identity guard. No mutable authority cache. |
| Attempt-catalog construction | 32.6 / 39.7 | 26.2 / 29.5 | The internal constructor validates a detached snapshot, computes its digest once and uses the existing immutable identity cache. It no longer hashes its own newly computed digest a second time. |
| Attempt-catalog persistence | 44.4 / 53.6 | 41.1 / 53.3 | A fresh insert uses its actual `RETURNING` header, removing one SQL read. Conflicting replays still reload the original row. Both paths still hydrate and verify stored blobs. |

These phase-median reductions are **2.9, 6.4 and 3.3 ms**. They do not explain
every millisecond of the overall change: unmodified phases also drifted on the
shared host. Both run pairs improved, but this is a modest local optimization,
not evidence for a fourfold deployment-wide speedup. Existing immutable-catalog
caches and eager dispatch remain in place; live authorization, connection
selection and workspace settings are deliberately not cached across turns.

## End-to-end local measurements

Real loopback HTTP API, Temporal workflow/control and turn workers, Core NATS,
fully migrated restricted-role PostgreSQL with FORCE RLS, and production agent
runtime. Only the model transport is scripted. Each sample creates a fresh
ordinary chat and asks for `OK`; **no paid calls** occur in this experiment.
Run order: baseline/candidate/candidate/baseline, 30 measured turns plus three
warm-ups in each process: **60 measured turns per revision**. The same shared
infrastructure and isolated task queues/databases are used without restarting
or reconfiguring unrelated services. Nearest-rank median and p90:

| Interval | Before median/p90 ms | After median/p90 ms |
| --- | ---: | ---: |
| HTTP request → actual model dispatch | 426 / 561 | 406 / 518 |
| `turn.queued` → actual model dispatch | **387 / 478** | **362 / 450** |
| `turn.queued` → request-start event | 382 / 472 | 357 / 444 |
| queued → started | 143 / 188 | 136 / 179 |
| started → credential-mint completion | 39 / 72 | 34 / 63 |
| credential-mint completion → tools start | 40 / 57 | 38 / 47 |
| tools start → completion | 92 / 105 | 81 / 94 |
| tools completion → model-preparation start | 43 / 56 | 40 / 55 |
| model preparation → request-start event | 22 / 31 | 21 / 27 |
| request-start event → actual dispatch | 5 / 7 | 5 / 6 |

The independent run-pair queued-to-dispatch medians/p90s were
**394/478 → 367/455 ms**, then **368/467 → 350/435 ms** in reverse execution
order. The aggregate gain is **25 ms median (6.5%)**, **28 ms p90 (5.9%)**.
The local 600 ms target is met, but the baseline already met it. Do not subtract
or sum independent percentiles to derive another interval.

Retained pre-change staging events were also checked: 74 everyday-task turns
had actual queued-to-request-event **2,437/5,545 ms** median/p90. Their constituent
medians were 889 ms queue, 261 ms through credential mint, 230 ms to tools,
308 ms tools, 398 ms to model preparation and 224 ms preparation. Unlike the
local fixture these include remote services and ordinary task configurations.
The changes have not been deployed as part of this experiment, so there is no
staging before/after claim. Large remote inter-phase gaps remain an investigation
target; their event timestamps alone cannot separate pool contention, network
RTT, SQL execution and event delivery.

## Byte-for-byte first-request proof

`verify-turn-startup-request.ts` admits a synthetic turn once and clones that
database into two isolated databases. Separate processes load the baseline and
candidate production worker/runtime against the same accepted input, identity,
history and attempt. The complete serialized first SDK `ModelRequest` matches:

- **196,299 bytes**, 66 tools, comparison via `Buffer.equals`.
- Before and after SHA-256:
  `f96ce4352ababf008001dd3b92453235cdd20890e4915b270b881345a1f492d2`.
- **No normalization** of timestamps, UUIDs, instructions, messages, schemas,
  descriptions, key order or tool order.

This is an SDK-request proof at the model transport boundary, not a comparison
of provider-generated HTTP headers. No provider adapter or request serializer
changed. Catalog tests additionally compare varied ordered schemas/metadata
against the original construction algorithm, and retain mutation-isolation,
tamper rejection, exact-attempt, replay, permission and control-fence coverage.

## Model-side prompt-size experiment (separate from startup)

The same Azure Responses model and `medium` reasoning setting were used through
the public API. Two synthetic sessions received the same one-line question:
ordinary full configuration and the smallest platform configuration
(`capabilities: none`, short identity/instructions, no sandbox). After one warm-up
each, ten turns per arm alternated. Histories grow symmetrically by one short
question/answer. This changes only experiment sessions, never production defaults.

| Warm measurement | Full | Minimal platform configuration |
| --- | ---: | ---: |
| Input tokens, median | 17,515 | 6,336 |
| Aggregate cached-input fraction | 99.70% | 99.18% |
| First-byte timer, median/p90 ms | 464 / 669 | 197 / 485 |
| Wire dispatch → first text, median/p90 ms | 1,958 / 2,449 | 1,447 / 1,760 |
| Request-start event → first text, median/p90 ms | 2,237 / 2,477 | 1,582 / 1,829 |

The approximately **511 ms median** wire-to-text difference suggests that a large
cached prompt still has latency cost. It is not a pure prompt-size causal estimate:
only ten samples per arm, different platform configurations/tool counts, provider
variation, and event-timestamp delivery effects remain. The minimal configuration
still contains mandatory platform context; a bare provider prompt was not tested.
The first-byte value uses the event's elapsed timer; first text uses retained
event time and `initialWireDispatchedAt`. Total measured API-equivalent cost,
including both warm-ups, was **$0.095712** (22 short turns).

## Reproduction and verification

Use a disposable pgvector PostgreSQL maintenance URL, reachable NATS/Temporal,
and an immutable baseline checkout with installed dependencies. Raw captures
remain local and must not be committed; they can contain experiment identities.

```sh
export OPENGENI_REQUIRE_REAL_DB=1
export OPENGENI_TEST_PG_URL=postgres://postgres:x@127.0.0.1:61440/postgres
export OPENGENI_TEST_NATS_URL=nats://127.0.0.1:4222
export OPENGENI_TEST_TEMPORAL_HOST=127.0.0.1:7233
export OPENGENI_BENCH_SAMPLES=30
bun scripts/bench-turn-startup.ts .startup/after.json
bun scripts/verify-turn-startup-request.ts "$BASELINE_WORKTREE"
bun scripts/compare-turn-startup.ts .startup/before.json .startup/after.json \
  .startup/before-2.json .startup/after-2.json
```

Copy the unchanged benchmark into the baseline checkout to measure it. The
request-proof harness loads baseline modules directly. The optional paid
`bench-prompt-latency.ts` requires explicit API base, model and API-key-file
environment variables; it never obtains provider credentials and limits itself
to the stated experiment. Do not run it without permission to spend on those calls.

Verification: **59 targeted tests, 355 assertions passed**, covering overlap/join
failures, unchanged selection branches, catalog byte equality, immutable
verification, RLS, replay and persisted content. Root typecheck and root oxlint
passed; changed TypeScript files passed oxfmt. Public-API compatibility and public
repository hygiene passed. Keep this change as a draft until the request/cache
and behavior implications have been reviewed.
