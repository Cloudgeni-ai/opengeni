# Post-provision startup measurements

Measured October 25, 2026, on Linux x64 with Bun 1.4.4 and Node 22.23.3.
Baseline: `62cc7f4399008`. Twenty fresh local workspaces per cell; medians in
milliseconds. No model calls, cloud sandboxes, real credentials or deployed
systems were used.

## What the previously unlabelled interval contains

For lazy owned boxes, `sandbox.provision` completes **before** these steps:

1. Delivery of the provisioning-completion receipt finishes.
2. Join the prefetched Git credential mint and mint a fresh exact-attempt
   Codemode bearer. The Git mint has already started alongside provisioning;
   only its remaining wait belongs in this interval.
3. Load the release-owned client, ensure its digest-addressed storage object
   exists, and sign a fresh download URL.
4. Stop/join the previous run-credential renewal writer, then admit, write or
   clear the initial credential generation under the existing workspace fence.
   An already-near-expiry generation may require an immediate refresh.
5. Enter owned setup: manifest reconciliation, shared rig coordination (when
   configured), then artifact/credential/client/seed/repository hooks. Rig setup
   precedes the turn-private hooks; several of those hooks already overlap.

The original 4,345 ms observation has no timings for these operations. It cannot
be retrospectively split into trustworthy per-step numbers. In particular,
neither a local shell time nor an injected transport delay is evidence of how
much time Modal or compute spent in that historical sample.

The new completion-only startup receipts and matching startup histogram/spans
separate credential resolution, mint/join, materialization, client publication,
client readiness, credential seeding/hooks and artifact runtime readiness.
Binding, full prefetched Git mint, provisioning-receipt delivery and timing-batch
delivery have additional bounded startup metrics. Eager and lazy owned setup use
the same hook observation. Receipts are batched at preparation boundaries and
retain their actual completion timestamps; the timings table sorts by start.
These intervals overlap and are **not additive**.

## One fix: overlap independent post-provision prerequisites

Credential mint/join, storage publication and run-credential materialization
now run concurrently. All started work settles before setup proceeds or fails;
failure selection preserves the old serial precedence. Credential scope,
workspace fences, fresh URL signing, renewal registration and rig/repository
dependencies are unchanged.

| Transport fixture | Publication cache | Before | After | Difference |
| --- | --- | ---: | ---: | ---: |
| Local, no injected delay | Cold | 35.38 | 36.00 | +0.62 |
| Local, no injected delay | Warm | 33.76 | 33.34 | -0.42 |
| Controlled 100 ms per boundary | Cold | 541.53 | 303.80 | -237.73 (43.9%) |
| Controlled 100 ms per boundary | Warm | 339.42 | 135.95 | -203.47 (59.9%) |

There is **no meaningful zero-delay speedup**. The fix removes serialized
waiting; it does not reduce token signing or shell work. The delayed rows are
latency-sensitivity experiments, **not measured cloud-provider improvements**.
The publication cache is normally already warm at lazy use because agent
construction publishes the same release asset first. A cold publication also
models first-use/recheck/recovery from unavailable storage.

The controlled cold-publication baseline breaks down as follows (independent
medians need not sum exactly to the median total):

| Operation | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Remaining Git-mint wait | 100.16 | 101.00 | Controlled unfinished mint, not a Git provider measurement |
| Actual exact-attempt token signing | 0.26 | 0.60 | Local cryptographic work |
| Client publication | 303.61 | 302.82 | Three controlled storage boundaries: head, put, sign |
| Actual credential materialization plus one controlled command boundary | 136.26 | 135.62 | Same production shell and private generation write |
| Post-provision prerequisite wall time | 541.53 | 303.80 | Serial sum becomes the longest concurrent branch |
| Subsequent client install/verification | 191.39 | 190.42 | Unchanged; separate from prerequisite timing |

Without injected delay, signing took 0.21 ms, cold client publication 2.05 ms,
credential materialization 32.13 ms, and subsequent client install/verification
81.39 ms on the baseline. This does **not** reproduce a 4.3-second local gap.
Building the client from a checkout took about 50–54 ms once per benchmark
process; release workers load packaged bytes instead. Client payload: 760,742
bytes. The benchmark warms that loader before timing either source revision.

## Reproduce and interpret

```bash
OPENGENI_BENCH_SAMPLES=20 bun scripts/bench-post-provision-startup.ts 62cc7f4399008
OPENGENI_BENCH_SAMPLES=20 bun scripts/bench-post-provision-startup.ts
```

The script extracts and executes the actual production prerequisite block from
each revision. It uses the same real token signer, run-credential materializer,
release client, local HTTP download and isolated shell for both. Credential
material is synthetic (two environment values and one small file). It separately
measures client installation. Cold and warm publication cases use the same
storage helper with controlled storage operations; Git wait is controlled too.
At 100 ms, each Git wait, storage operation and shell command incurs that delay.
Signing a storage URL may be local in a real deployment, so the fixture must not
be read as a claim that every provider incurs that delay.

This is not an end-to-end turn benchmark. It excludes database admission and
event delivery, renewal transport, rig/repository/file setup, model preparation,
and sandbox provisioning. Timing receipt delivery adds one batch per observed
preparation boundary, not one append per hook; `startup_phase_delivery` exposes
that cost. A worker crash before a boundary flush can still lose the batch,
just as an interrupted operation has no completion duration.

## Remaining time and risk

- With the controlled cold cache, about 303 ms remains on the publication
  branch; with a warm cache, about 136 ms remains on materialization. Neither
  dependency can be skipped before setup is ready.
- Client installation still takes one verified provider command in the download
  path (about 81 ms local, 190 ms with the injected boundary in this experiment).
  Missing storage/download support keeps the existing verified editor fallback,
  which may take more round trips. No provider-specific behavior was changed.
- Live provider latency, credential-provider refresh, database/lease contention
  and shared rig coordination were not measured here. The new intervals plus
  existing workspace-mutation/shared-preparation metrics make the next real
  sample attributable. No claim is made that 4,345 ms has been eliminated.
- Parallel setup can start materialization even if credential minting later
  fails. It uses the same already-authorized material and exact workspace fence;
  all work is joined before disposal, and normal attempt cleanup remains owner.
- No prompts, tool schemas, model-facing results, model-history ordering or
  selected client bytes change. New data is diagnostic startup telemetry only.
